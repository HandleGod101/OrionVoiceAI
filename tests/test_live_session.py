"""Offline contract tests for the Live handler; no credentials or API calls."""
import ast
import asyncio
import json
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]

class HTTPException(Exception):
    def __init__(self, status_code, detail):
        self.status_code, self.detail = status_code, detail

class LiveSessionTests(unittest.TestCase):
    def setUp(self):
        self.payload = None
        self.answer = {'transport': {'sdp': 'answer'}, 'session': {'id': 'live_test'}}
        self.status = 200
        owner = self
        class Client:
            def __init__(self, **kwargs): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def post(self, url, **kwargs):
                owner.url = url
                owner.payload = kwargs['json']
                return SimpleNamespace(status_code=owner.status, text='mock error', json=lambda: owner.answer)
        scenario = json.loads((ROOT/'scenarios.json').read_text())[0]
        tree = ast.parse((ROOT/'app.py').read_text())
        handler = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == 'create_live_session')
        self.routes = [n.args[0].value for n in handler.decorator_list]
        handler.decorator_list = []
        self.ns = dict(json=json, OPENAI_API_KEY='test-placeholder', LIVE_MODEL='gpt-live-1',
                       LiveSessionRequest=object, HTTPException=HTTPException,
                       OPTIONS={'communication': ['quiet'], 'difficulty': ['medium']},
                       scenario_by_id=lambda sid: scenario,
                       resolve_for_scenario=lambda s,v,k: v,
                       log=SimpleNamespace(error=lambda *args: None),
                       httpx=SimpleNamespace(AsyncClient=Client, RequestError=ConnectionError))
        builder = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'build_live_instructions')
        exec(compile(ast.Module(body=[builder, handler], type_ignores=[]), 'app.py','exec'), self.ns)
        self.body = SimpleNamespace(scenario_id=scenario['id'],call_type='outbound',communication='quiet',difficulty='medium',sdp='offer')
    def call(self): return asyncio.run(self.ns['create_live_session'](self.body))
    def test_main_and_test_routes_share_live_handler(self):
        self.assertEqual(set(self.routes), {'/api/session', '/api/live/session'})
        result = self.call()
        self.assertEqual(self.url, 'https://api.openai.com/v1/live/sessions')
        self.assertEqual(self.payload['transport'], {'type':'webrtc','sdp':'offer'})
        self.assertEqual(self.payload['session']['model'], 'gpt-live-1')
        self.assertFalse(self.payload['session']['store'])
        self.assertEqual(result['sdp'], 'answer')
        self.assertEqual(result['scenario']['id'], self.body.scenario_id)
        self.assertNotIn('client_secret', result)
        self.assertEqual(self.payload['session']['input'][0]['role'], 'developer')
    def test_inbound_and_variations_reach_live_prompt(self):
        self.body.call_type='inbound'
        self.call()
        prompt=self.payload['session']['instructions']
        self.assertIn('Call direction: inbound', prompt)
        self.assertIn('Communication style: quiet. Difficulty: medium.', prompt)
    def test_full_private_scenario_reaches_model_but_not_response(self):
        scenario = json.loads((ROOT/'scenarios.json').read_text())[0]
        scenario['behavior_rules'].extend(['extra rule'] * 12 + ['final rule must survive'])
        self.ns['scenario_by_id'] = lambda sid: scenario
        result = self.call()
        prompt = self.payload['session']['instructions']
        for key in ('consumer', 'account', 'situation', 'hidden_facts', 'behavior_rules',
                    'voice_style', 'resolution_behavior', 'mock_payment_card'):
            self.assertIn(json.dumps(scenario[key], ensure_ascii=False), prompt)
        self.assertIn('final rule must survive', prompt)
        self.assertNotIn(scenario['mock_payment_card']['number'], json.dumps(result))

    def test_scenarios_without_optional_fields_and_all_variations(self):
        build = self.ns['build_live_instructions']
        scenarios = json.loads((ROOT/'scenarios.json').read_text())
        for scenario in scenarios:
            for style in ('quiet', 'talkative', 'impatient', 'confused'):
                for difficulty in ('easy', 'medium', 'hard'):
                    prompt = build(scenario, {'communication': style, 'difficulty': difficulty}, 'outbound')
                    self.assertIn(scenario['consumer']['name'], prompt)
                    self.assertIn(json.dumps(scenario['resolution_behavior'], ensure_ascii=False), prompt)
                    if 'mock_payment_card' not in scenario:
                        self.assertNotIn('FICTIONAL TRAINING CARD', prompt)

    def test_invalid_direction_does_not_contact_provider(self):
        self.body.call_type='invalid'
        with self.assertRaises(HTTPException) as error: self.call()
        self.assertEqual(error.exception.status_code,400)
        self.assertIsNone(self.payload)
    def test_missing_sdp_answer_reports_error(self):
        self.answer={'session': {'id':'live_test'}}
        with self.assertRaises(HTTPException) as error: self.call()
        self.assertEqual(error.exception.status_code,502)
    def test_provider_rejection_reports_error(self):
        self.status=400
        with self.assertRaises(HTTPException) as error: self.call()
        self.assertEqual(error.exception.status_code,502)

if __name__=='__main__': unittest.main()
