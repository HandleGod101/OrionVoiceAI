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
  "account": {"balance": 1000, "status": "No active arrangement."},
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
