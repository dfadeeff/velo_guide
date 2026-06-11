.PHONY: setup run lint test smoke eval feedback-report clean

setup:
	cd backend && npm install

run:
	cd backend && npx tsx src/main.ts

lint:
	cd backend && npx tsc --noEmit

# Offline unit tests (no network, no API key) — same as the CI `checks` job
test:
	cd backend && npm test
# One real headless agent turn with a tool/latency trace and grounding checks.
# Optional: PROMPT="Plan a 2-day trip from Utrecht" make smoke
smoke:
	cd backend && npx tsx src/smoke.ts $(if $(PROMPT),"$(PROMPT)")

# Run the eval suite (backend/eval/test-cases.json). Optional: CASE=basic-day-trip make eval
eval:
	cd backend && npx tsx eval/run-eval.ts $(if $(CASE),--case $(CASE))

# Turn captured thumbs up/down (FEEDBACK_DB) into eval signal: satisfaction
# rate + downvoted turns emitted as candidate regression cases. Add --write to
# also write eval/regression-candidates.json. Requires FEEDBACK_DB to be set.
feedback-report:
	cd backend && npx tsx eval/feedback-report.ts

clean:
	rm -rf backend/node_modules
