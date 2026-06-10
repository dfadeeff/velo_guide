.PHONY: setup run lint smoke eval clean

setup:
	cd backend && npm install

run:
	cd backend && npx tsx src/main.ts

lint:
	cd backend && npx tsc --noEmit

# One real headless agent turn with a tool/latency trace and grounding checks.
# Optional: PROMPT="Plan a 2-day trip from Utrecht" make smoke
smoke:
	cd backend && npx tsx src/smoke.ts $(if $(PROMPT),"$(PROMPT)")

# Run the eval suite (backend/eval/test-cases.json). Optional: CASE=basic-day-trip make eval
eval:
	cd backend && npx tsx eval/run-eval.ts $(if $(CASE),--case $(CASE))

clean:
	rm -rf backend/node_modules backend/dist
