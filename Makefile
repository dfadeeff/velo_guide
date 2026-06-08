.PHONY: setup run lint clean

setup:
	cd backend && npm install

run:
	cd backend && npx tsx src/main.ts

lint:
	cd backend && npx tsc --noEmit

clean:
	rm -rf backend/node_modules backend/dist
