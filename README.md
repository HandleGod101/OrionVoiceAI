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

If new computer:

```bash
python -m pip install -r requirements.txt
```

Copy `.env.example` to `.env`, add your key, then:

```bash
python -m uvicorn app:app --host 127.0.0.1 --port 8000 --reload & open http://127.0.0.1:8000

```

Open `http://localhost:8000`.

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

`/api/scenarios` deliberately strips `account`, `situation`, and `hidden_facts`, so the browser/collector does not receive those fields.

Use fictional/anonymized training information; don't paste real consumer PII into the scenario library.
