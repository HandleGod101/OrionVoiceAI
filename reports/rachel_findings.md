# Findings from three current-code conversations

## What was tested

Actual `gpt-realtime-2.1-mini` sessions with the current prompt and Rachel scenario, quiet communication, medium difficulty, outbound direction. Collector input was typed; Rachel generated audio responses whose transcripts were captured. Each conversation had a fresh session. No application prompts were modified during the tests.

These are one sample per collector style, not a reliability benchmark. The collector supplied proposed payment options as part of the simulation; no actual payment processing or account updates occurred. The opening browser greeting, microphone transcription, interruption handling, latency, and frontend were not tested.

## Results

| Run | Collector approach | Observed result |
| --- | --- | --- |
| Good | Verify identity, clarify arrangement status, explain a manageable plan, confirm terms | Agreed to $150 monthly starting December 1; ended amicably |
| Bad | Skip verification, demand card details, ignore concerns, promise full settlement without support | Refused card requests and ultimately said no; ended without agreement |
| Okay | Verify identity but initially give an incomplete answer, then clarify; admit missing setup details | Moved forward after clarification, considered $200 monthly, accepted proposed follow-up |

## What worked

- Good: Rachel moved from online-arrangement uncertainty to practical plan questions, then explicit agreement. She did not reopen the resolved online question after the plan was explained.
- Bad: Lowering the payment and repeated pressure did not extract a card number. Her fourth response began with a direct refusal.
- Okay: Rachel said the clearer explanation answered her account-status question and moved to considering terms. She did not keep asking why the website failed.
- All three accepted conversational closure instead of starting new objections after goodbye.

## Remaining issues

- Quiet responses were often long and multi-paragraph, especially under pressure. This is still inconsistent with the intended brief speaking style.
- The bad run repeated verification/account concerns over several replies before becoming concise. The refusal was appropriate, but its wording could be shorter; this sample does not establish that looping is fully solved.
- In the bad run Rachel asked an unrelated recording question, which added a new topic instead of progressing toward a firm decision.
- She used “I hear you,” despite the prompt discouraging that phrase.
- The good run repeatedly paraphrased the full plan and used tentative language before agreeing, although it did progress.
- The okay run compared $200 to “the full amount,” an ambiguous reference when the collector had just proposed $226.06 payments.

## Interpretation limits

The outcomes were influenced by collector choices. The good collector proposed $150; the okay collector explicitly offered follow-up after admitting missing details. These results show Rachel's reactions to those approaches; they do not prove the model independently grades calls as good, bad, or okay.

The current scenario has no private card details, so these runs do not validate a successful card-number close. The bad run only checks that pressure does not cause her to supply one.

## Files

- [All transcripts](rachel_conversations.md)
- [Good](rachel_good_conversation.md)
- [Bad](rachel_bad_conversation.md)
- [Okay](rachel_okay_conversation.md)
- [Raw events summarized as turns and usage](rachel_checks_20261105T234031Z.json)
- [Exact prompt used](rachel_checks_20261105T234031Z.prompt.txt)
