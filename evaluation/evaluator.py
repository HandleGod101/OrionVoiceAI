"""Stateless, transcript-only training feedback. No database or file writes."""
import json
import os
import httpx

SYSTEM = """You are an independent post-call QA reviewer for a FICTIONAL debt-collection training simulation involving Rachel Carter. You are NOT Rachel. Grade only evidence in the supplied transcript. Do not assume an event happened because it is required, and never invent quotes. The transcript is speech-to-text and may contain errors, missing endings, or incorrect order. Evaluate the collector, not the consumer.

Four compliance criteria:
1 recording_disclosure: Collector clearly tells consumer the call is recorded. Check that this happens at the appropriate opening; if later, mention timing.
2 identity_verification: Collector performs reasonable identity verification BEFORE revealing account-specific protected details. A mere name confirmation alone is not sufficient. If no account details are discussed, determine if not_applicable; if transcript is incomplete use needs_review. Note order explicitly.
3 mini_miranda: Collector conveys the debt-collector identity, attempt to collect a debt, and information-use disclosure. Accept clear semantic equivalents; do not require exact wording. Mark partial as fail, unless transcript uncertainty requires needs_review.
4 collector_full_name: Collector provides first and last name (not just first name). Do not infer name from UI or transcript labels.

Statuses: pass, fail, needs_review, not_applicable. For a complete, clearly transcribed call, missing required disclosure is fail. For truncated, garbled, or ambiguous transcript, needs_review. No transcript or inadequate agent turns => needs_review, not fabricated fail. Mark timing-related failures where relevant. Evidence must reference actual turn IDs and short verbatim snippets; if absent use empty evidence and explain.

Performance criteria (score integer 0-5 each): objection_handling, communication, negotiation, closing. Evaluate active listening, Rachel's online-arrangement concern, clarity and respect, affordability exploration, truthful/authorized claims, and whether the collector achieved a reasonable close OR clear follow-up without coercion. A good follow-up can score well. No negotiation opportunity -> mark needs_review with null score rather than penalizing. Base all conclusions on actual turns. Any unsubstantiated guarantee such as 'this closes the account forever' is a negative, not a positive trigger. Never treat the consumer's agreement alone as proof of skill.

Return ONLY a JSON object with fields: compliance (object keyed recording_disclosure, identity_verification, mini_miranda, collector_full_name; each {status, reason, evidence:[{turn_id,quote}]}), performance (object keyed objection_handling, communication, negotiation, closing; each {status:'scored'|'needs_review', score:integer 0-5 or null, reason, evidence:[{turn_id,quote}]}), strengths (array of up to 3 strings), improvements (array of up to 3 strings), overall_summary (string). No markdown. No additional keys. Don't produce a single compliance pass/fail overall score. Training feedback only, not a legal determination."""
COMPLIANCE = ("recording_disclosure", "identity_verification", "mini_miranda", "collector_full_name")
PERFORMANCE = ("objection_handling", "communication", "negotiation", "closing")

def normalize_result(data, valid_ids):
    out = {"compliance": {}, "performance": {}, "strengths": [], "improvements": [], "overall_summary": ""}
    def evidence(items):
        if not isinstance(items, list): return []
        return [{"turn_id": x["turn_id"], "quote": str(x.get("quote", ""))[:240]}
                for x in items[:5] if isinstance(x, dict) and x.get("turn_id") in valid_ids]
    for key in COMPLIANCE:
        item = data.get("compliance", {}).get(key, {})
        status = item.get("status")
        if status not in ("pass", "fail", "needs_review", "not_applicable"): status = "needs_review"
        out["compliance"][key] = {"status": status, "reason": str(item.get("reason", "Insufficient evidence."))[:600], "evidence": evidence(item.get("evidence"))}
    for key in PERFORMANCE:
        item = data.get("performance", {}).get(key, {})
        score = item.get("score")
        if isinstance(score, bool) or not isinstance(score, int) or not 0 <= score <= 5: score = None
        status = "scored" if score is not None and item.get("status") == "scored" else "needs_review"
        out["performance"][key] = {"status": status, "score": score if status == "scored" else None, "reason": str(item.get("reason", "Insufficient evidence."))[:600], "evidence": evidence(item.get("evidence"))}
    for key in ("strengths", "improvements"):
        values = data.get(key, [])
        if isinstance(values, list): out[key] = [str(v)[:280] for v in values[:3]]
    out["overall_summary"] = str(data.get("overall_summary", ""))[:1000]
    return out

async def evaluate(turns, call_metadata, transcript_quality):
    payload = {"scenario": "Rachel Carter - Failed Payment Arrangement", "metadata": call_metadata, "transcript_quality": transcript_quality, "turns": turns}
    model = os.getenv("OPENAI_EVALUATOR_MODEL", "gpt-4.1-mini")
    async with httpx.AsyncClient(timeout=65) as client:
        response = await client.post("https://api.openai.com/v1/chat/completions", headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}", "Content-Type": "application/json"}, json={"model": model, "temperature": 0, "response_format": {"type": "json_object"}, "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}]})
    response.raise_for_status()
    result = json.loads(response.json()["choices"][0]["message"]["content"])
    return normalize_result(result, {t["id"] for t in turns})
