"""Interactive Realtime behavior checks. Requires websockets and python-dotenv.
Run from the project root; commands arrive as JSON lines on stdin.
Legacy Realtime check using the archived app_old.py prompt, not the current Live app.
"""
import ast
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import quote
from datetime import datetime, timezone
from dotenv import load_dotenv
from websockets.sync.client import connect

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / '.env')
key = os.getenv('OPENAI_API_KEY', '').strip()
if not key:
    raise SystemExit('OPENAI_API_KEY is not configured; no conversations run.')
source = (ROOT / 'app_old.py').read_text()
node = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == 'prompt')
namespace = {'json': json}
exec(compile(ast.Module(body=[node], type_ignores=[]), 'app_old.py', 'exec'), namespace)
scenario = next(s for s in json.loads((ROOT / 'scenarios.json').read_text()) if s['consumer']['name'] == 'Rachel Carter')
# Use the legacy Realtime model default if the environment has no override.
model = os.getenv('OPENAI_REALTIME_MODEL', 'gpt-realtime-2.1').strip()
variation = {'communication': 'quiet', 'difficulty': 'medium'}
instructions = namespace['prompt'](scenario, variation, 'outbound')
report = {'started_utc': datetime.now(timezone.utc).isoformat(), 'requested_model': model,
          'variation': variation, 'direction': 'outbound',
          'method': 'Typed collector turns, Realtime audio responses; no microphone or browser test.',
          'prompt_sha256': hashlib.sha256(instructions.encode()).hexdigest(),
          'conversations': []}
run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
path = ROOT / 'reports' / f'rachel_checks_{run_id}.json'
path.with_suffix('.prompt.txt').write_text(instructions)
ws = None
current = None

def save():
    path.write_text(json.dumps(report, indent=2) + '\n')

def receive_until(kind):
    while True:
        event = json.loads(ws.recv(timeout=90))
        if event['type'] == 'error':
            raise RuntimeError(json.dumps(event.get('error', {})))
        if event['type'] == kind:
            return event

def emit(obj):
    print(json.dumps(obj), flush=True)

emit({'ready': True, 'model': model, 'report': str(path)})
try:
    for line in __import__('sys').stdin:
        command = json.loads(line)
        if command.get('command') == 'start':
            if ws:
                ws.close()
            ws = connect('wss://api.openai.com/v1/realtime?model=' + quote(model),
                         additional_headers={'Authorization': 'Bearer ' + key},
                         open_timeout=30, max_size=16 * 1024 * 1024, legacy=True)
            created = receive_until('session.created')
            ws.send(json.dumps({'type': 'session.update', 'session': {
                'type': 'realtime', 'instructions': instructions,
                'output_modalities': ['audio'], 'audio': {'output': {'voice': 'marin'}},
                'reasoning': {'effort': 'low'}, 'tools': [], 'max_output_tokens': 'inf'
            }}))
            updated = receive_until('session.updated')
            current = {'label': command['label'], 'actual_model': updated['session'].get('model'), 'turns': []}
            report['conversations'].append(current)
            save()
            emit({'started': current['label'], 'actual_model': current['actual_model']})
        elif 'say' in command:
            if not ws:
                raise RuntimeError('Start a conversation first.')
            current['turns'].append({'speaker': 'Collector', 'text': command['say']})
            save()
            ws.send(json.dumps({'type': 'conversation.item.create', 'item': {
                'type': 'message', 'role': 'user',
                'content': [{'type': 'input_text', 'text': command['say']}]
            }}))
            ws.send(json.dumps({'type': 'response.create'}))
            event = receive_until('response.done')
            response = event['response']
            parts = [part.get('transcript', part.get('text', ''))
                     for item in response.get('output', []) for part in item.get('content', [])]
            text = '\n'.join(filter(None, parts))
            current['turns'].append({'speaker': 'Rachel', 'text': text, 'status': response.get('status')})
            current.setdefault('usage', []).append(response.get('usage'))
            save()
            emit({'rachel': text, 'status': response.get('status')})
            if response.get('status') != 'completed':
                emit({'details': response.get('status_details')})
        elif command.get('command') == 'finish':
            break
except Exception as exc:
    report['error'] = str(exc).replace(key, '[redacted]')
    save()
    emit({'error': report['error']})
finally:
    if ws:
        ws.close()
    save()
