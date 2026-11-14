import hashlib, json, logging, os, random, time
from pathlib import Path
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from typing import Literal
from evaluation.evaluator import evaluate

load_dotenv()
BASE_DIR=Path(__file__).resolve().parent
OPENAI_API_KEY=os.getenv("OPENAI_API_KEY","").strip()
LIVE_MODEL=os.getenv("OPENAI_LIVE_MODEL","gpt-live-1").strip()
logging.basicConfig(level=logging.INFO,format="%(asctime)s | %(levelname)s | %(name)s | %(message)s")
log=logging.getLogger("orion-voice")
app=FastAPI(title="Orion Voice Training Prototype",version="0.2.0")
app.mount("/static",StaticFiles(directory=BASE_DIR/"static"),name="static")

@app.middleware("http")
async def refresh_frontend(request, call_next):
 response = await call_next(request)
 if request.url.path == "/" or request.url.path.startswith("/static/") or request.url.path.startswith("/api/"):
  response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
  response.headers["Pragma"] = "no-cache"
  response.headers["Expires"] = "0"
 return response

OPTIONS={
 "communication":["quiet","talkative","impatient","confused"],
 "difficulty":["easy","medium","hard"],
}

class SessionRequest(BaseModel):
 scenario_id:str
 communication:str="random"
 difficulty:str="random"
 call_type:str="outbound"

def scenarios():
 return json.loads((BASE_DIR/"scenarios.json").read_text(encoding="utf-8"))

def scenario_by_id(sid):
 for s in scenarios():
  if s["id"]==sid:return s
 raise HTTPException(404,f"Unknown scenario: {sid}")

def allowed_for_scenario(s,key):
 locked=s.get("locked_traits",{})
 if key in locked:
  return [locked[key]]
 return s.get("allowed_variations",{}).get(key,OPTIONS[key])

def resolve_for_scenario(s,value,key):
 allowed=allowed_for_scenario(s,key)
 if value=="random":
  return random.choice(allowed)
 if value not in allowed:
  raise HTTPException(400,f"{value!r} is not allowed for {key} in scenario {s['id']}. Allowed: {allowed}")
 return value

def scenario_options(s):
 locked=s.get("locked_traits",{})
 return {key:{"values":allowed_for_scenario(s,key),"locked":key in locked,"locked_value":locked.get(key)} for key in OPTIONS}

@app.get("/")
async def home():
 html = (BASE_DIR/"static"/"index.html").read_text(encoding="utf-8")
 for asset in ("app.js", "styles.css"):
  version = hashlib.sha256((BASE_DIR/"static"/asset).read_bytes()).hexdigest()[:16]
  html = html.replace(f'/static/{asset}?v=4', f'/static/{asset}?v={version}')
 return HTMLResponse(html)

@app.get("/api/health")
async def health(): return {"ok":True,"api_key_configured":bool(OPENAI_API_KEY),"model":LIVE_MODEL,"server_time":int(time.time())}

@app.get("/api/options")
async def get_options(): return OPTIONS

@app.get("/api/scenarios/{scenario_id}/options")
async def get_scenario_options(scenario_id:str):
 return scenario_options(scenario_by_id(scenario_id))

@app.get("/api/scenarios")
async def get_scenarios():
 # Expose only the fictional collector-facing record, never AI-only scenario facts.
 return [{"id":s["id"],"name":s["name"],
          "collector_brief":s.get("collector_brief",""),
          "consumer":s.get("consumer",{}),
          "account":s.get("account",{})} for s in scenarios()]

# Stateless evaluation: transcript is sent once by the browser after the call.
# No transcript, result, or user history is written to disk or retained server-side.
class TranscriptTurn(BaseModel):
 id: str = Field(min_length=1, max_length=100)
 speaker: Literal["agent", "consumer"]
 text: str = Field(min_length=1, max_length=4000)
 timestamp_ms: int = Field(ge=0, le=7200000)

class EvaluationRequest(BaseModel):
 scenario_id: Literal["failed_payment_arrangement"]
 turns: list[TranscriptTurn] = Field(min_length=1, max_length=400)
 metadata: dict = Field(default_factory=dict)
 transcript_quality: dict = Field(default_factory=dict)

@app.post("/api/evaluate")
async def evaluate_call(body: EvaluationRequest):
 if not OPENAI_API_KEY: raise HTTPException(500, "OPENAI_API_KEY missing")
 turns = [t.model_dump() for t in body.turns]
 if len({t["id"] for t in turns}) != len(turns): raise HTTPException(400, "Duplicate transcript turn IDs")
 turns.sort(key=lambda t: (t["timestamp_ms"], int(t["id"].split("-")[-1]) if t["id"].split("-")[-1].isdigit() else 0))
 try:
  return await evaluate(turns, {k:v for k,v in body.metadata.items() if k in ("call_type", "communication", "difficulty", "duration_ms")}, body.transcript_quality)
 except (httpx.HTTPError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
  log.error("Evaluator unavailable: %s", type(exc).__name__)
  raise HTTPException(502, "Evaluation service unavailable. Please retry while this call's transcript is still on screen.")


# Live voice sessions used by the main interface.
class LiveSessionRequest(SessionRequest):
    sdp: str = Field(min_length=50, max_length=100000)

def build_live_instructions(scenario, variation, call_type):
    """Build private model instructions without truncating scenario guidance."""
    communication = {
        "quiet": "Give brief answers; expand when a useful question calls for detail.",
        "talkative": "Give somewhat longer answers and occasional natural tangents, without repetitive summaries.",
        "impatient": "Prefer an efficient conversation; show less patience with repetition or unclear explanations.",
        "confused": "Ask reasonable clarification questions when explanations are unclear, without becoming incompetent."
    }
    difficulty = {
        "easy": "Be relatively forgiving and receptive, while still requiring understandable, workable terms.",
        "medium": "Show realistic hesitation that responds to useful explanations and appropriate options.",
        "hard": "Require clearer explanations and stronger objection handling; a workable resolution remains achievable."
    }

    sections = [
        f"""

ROLE AND CALL
You are {scenario.get('consumer', {}).get('name', 'a consumer')}, a fictional consumer in a realistic training call with a debt collector from Orion Capital Solutions.
Stay in character. You are not a coach, evaluator, or assistant. Never mention being simulated or describe internal rules.
Call direction: {call_type}. If outbound, the collector called you; answer with a brief natural greeting, then listen. If inbound, you called the agency and explain why when asked. Adapt the scenario's callback framing to this direction without changing its facts.
Do not disclose protected account information before reasonable identity verification. 
Don't volunteer personal information. 
Never provide payment card details unless specific terms were clearly agreed and the collector asks; any supplied card is fictional training data. 
Never claim a real payment was processed.

COMMUNICATION
Communication style: {variation['communication']}. Difficulty: {variation['difficulty']}.
{communication[variation['communication']]}
{difficulty[variation['difficulty']]}

Speak casually with contractions and natural pauses. 
Default to short replies, allowing more detail for the selected communication style. 
Don't summarize or praise the collector, follow a rigid script, or invent objections to extend the call.
React to what was actually said and remember what was already explained. 
Express decisions naturally, never as stages, scores, or outcome labels.

"""
    ]
    # Keep scenario content explicit: metadata and dropdown restrictions are not prompts.
    for label, key in (
        ("SCENARIO", "name"),
        ("CONSUMER IDENTITY", "consumer"),
        ("ACCOUNT — PRIVATE UNTIL VERIFICATION", "account"),
        ("SITUATION", "situation"),
        ("PRIVATE BACKGROUND", "hidden_facts"),
        ("SCENARIO ACTIONS", "behavior_rules"),
        ("VOICE STYLE", "voice_style"),
        ("DECISION-MAKING AND PROGRESSION", "resolution_behavior"),
        ("FICTIONAL TRAINING CARD — PRIVATE, ONLY WHEN AGREED AND REQUESTED", "mock_payment_card"),
    ):
        value = scenario.get(key)
        if value:
            sections.append(f"{label}\n{json.dumps(value, ensure_ascii=False)}")
    return "\n\n".join(sections)


@app.post("/api/session")
@app.post("/api/live/session")
async def create_live_session(body: LiveSessionRequest):
    if not OPENAI_API_KEY:
        raise HTTPException(500, "OPENAI_API_KEY missing from .env")
    if body.call_type not in ("inbound", "outbound"):
        raise HTTPException(400, "call_type must be inbound or outbound")
    scenario = scenario_by_id(body.scenario_id)
    variation = {k: resolve_for_scenario(scenario, getattr(body, k), k) for k in OPTIONS}

    live_instructions = build_live_instructions(scenario, variation, body.call_type)

    payload = {
        "session": {
            "model": LIVE_MODEL,
            "instructions": live_instructions,
            "input": [{"role": "developer", "content": [{"type": "input_text", "text":
                "Begin now in English with only a short natural hello, then pause and listen to the collector. Do not volunteer account details in the greeting."}]}],
            "audio": {"output": {"voice": "marin"}},
            "delegation": {"type": "client"},
            "store": False
        },
        "transport": {"type": "webrtc", "sdp": body.sdp}
    }
    try:
        async with httpx.AsyncClient(timeout=45) as client:
            response = await client.post(
                "https://api.openai.com/v1/live/sessions",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
                json=payload
            )
    except httpx.RequestError as exc:
        raise HTTPException(502, f"Could not connect to GPT-Live: {exc}")
    if response.status_code >= 400:
        log.error("GPT-Live session rejected: %s %s", response.status_code, response.text)
        raise HTTPException(502, {"message": "GPT-Live rejected session", "status": response.status_code, "detail": response.text})
    result = response.json()
    answer = result.get("transport", {}).get("sdp")
    if not answer:
        raise HTTPException(502, "GPT-Live did not return an SDP answer")
    return {
        "sdp": answer,
        "session_id": result.get("session", {}).get("id"),
        "model": LIVE_MODEL,
        "variation": variation,
        "scenario": {"id": scenario["id"], "name": scenario["name"],
                     "consumer_name": scenario.get("consumer", {}).get("name", "Consumer")}
    }
