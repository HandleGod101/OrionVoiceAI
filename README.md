# Orion Voice Trainer V2

## New in V2
- JSON scenario library (`scenarios.json`)
- collector-facing brief separated from hidden AI context
- communication: quiet / talkative / impatient / confused
- difficulty: easy / medium / hard
- every dimension supports Random
- repeated runs of the same base scenario can therefore behave differently
- no grading/scoring

## Run

Enter environment:
```bash
conda activate voicebot
```
Then:
```bash
 ./run_mac.sh  
```

If needed
```bash
lsof -ti :8000 | xargs kill -9
```


To share
```bash
python -m uvicorn app:app --host 127.0.0.1 --port 8000

In new terminal run share_mac.sh
copy link
```


If installing on new computer:

```bash
python -m pip install -r requirements.txt

Copy `.env.example` to `.env`, add your key, then:

python -m uvicorn app:app --host 127.0.0.1 --port 8000 --reload & open http://127.0.0.1:8000

or  ./run_mac.sh  / ./run_windows.bat

```





## Adding your 100 scenarios

You only need to edit `scenarios.json`. Copy an existing object and give it a unique `id` based on the consumer’s name, using lowercase letters and underscores (for example, `Rachel Carter` becomes `rachel_carter`).

```json
{
  "id": "fictional_name",
  "name": "New Scenario",
  "description": "Admin-facing description.",
  "collector_brief": "Only what the trainee should know before the call.",
  "consumer": {"name": "Fictional Name"},
  "account": {
    "account_id": "TRAIN-AB-123456",
    "balance": 1000,
    "status": "No active arrangement."
  },
  "mock_payment_card": {
    "number": "0000 0000 0000 0000",
    "expiration": "12/30",
    "security_code": "000",
    "training_only": true
  },
  "situation": {
    "reason_for_call": "Why they called.",
    "consumer_belief": "What they think happened.",
    "actual_state": "What actually happened."
  },
  "hidden_facts": [
    "AI-only fact that should emerge naturally."
  ]
}
```

The scenario picker shows a fictional collector-facing account preview with the available consumer profile, account details, and payment history. `/api/scenarios` sends only `consumer`, `account`, and `collector_brief` for that preview; AI-only `mock_payment_card`, `situation`, `hidden_facts`, behavior rules, and voice style stay server-side. If a scenario uses `mock_payment_card`, use deliberately invalid training placeholders only.

Use fictional/anonymized training information; don't paste real consumer PII into the scenario library.


## Default voice engine: GPT-Live

The main page uses GPT-Live with a concise consumer prompt. Start the app normally and open `/`; scenario controls, inbound/outbound ringing, mute, transcript Copy/Clear, and Rachel's post-call evaluation remain available.

`OPENAI_LIVE_MODEL` defaults to `gpt-live-1`. `/api/session` and `/api/live/session` both accept the Live SDP request. The legacy Realtime endpoint and prompt have been removed from `app.py`. The legacy conversation-check script reads its prompt from `app_old.py`.

The server exchanges SDP with OpenAI; the API key stays on the server. Live transcript fragments are grouped by speaker and session timestamps for display and evaluation. End call requests graceful Live shutdown and waits up to 15 seconds for final transcripts; unconfirmed shutdown is flagged as incomplete. Clear hides the visible transcript but retains the current call's evaluation evidence until a new call or refresh.

The obsolete `/live-test` page route has been removed. No evaluation model or rubric was changed by the voice migration.
