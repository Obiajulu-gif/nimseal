.PHONY: help install check-env contracts-compile contracts-test contracts-coverage \
        contracts-deploy contracts-deploy-testnet contracts-configure-attestor contracts-smoke \
        sync-abi web-dev web-build web-test web-lint web-typecheck verify clean

help:
	@echo "nimSeal — confidential invoices for Nimiq Pay"
	@echo ""
	@echo "  make install                      Install contract and web dependencies"
	@echo "  make check-env                    Report which environment variables are set"
	@echo ""
	@echo "  make contracts-test               Run the Hardhat test suite"
	@echo "  make contracts-coverage           Solidity coverage report"
	@echo "  make contracts-deploy-testnet     Deploy NimSealEscrow to Sepolia (11155111)"
	@echo "  make contracts-deploy             Deploy NimSealEscrow to Polygon (137)"
	@echo "  make contracts-configure-attestor Set the attestor signing address on the escrow"
	@echo "  make contracts-smoke              Read-only checks against the deployed escrow"
	@echo ""
	@echo "  make sync-abi                     Copy the compiled ABI into web/lib/abi"
	@echo ""
	@echo "  make web-dev / web-build          Run or build the frontend"
	@echo "  make verify                       Every offline gate: tests, lint, types, build"

install:
	cd contracts && npm install
	cd web && npm install

check-env:
	node scripts/check-env.mjs

# --- Contracts --------------------------------------------------------------

contracts-compile:
	cd contracts && npm run compile

contracts-test:
	cd contracts && npm test

contracts-coverage:
	cd contracts && npm run coverage

contracts-deploy-testnet:
	cd contracts && npm run deploy:sepolia

contracts-deploy:
	cd contracts && npm run deploy:polygon

contracts-configure-attestor:
	cd contracts && npm run configure-attestor:polygon

contracts-smoke:
	cd contracts && npm run smoke:polygon

# --- ABI ---------------------------------------------------------------------

# Compiles first so the ABI cannot go stale.
sync-abi:
	cd contracts && npm run compile
	node scripts/sync-abi.mjs

# --- Web ---------------------------------------------------------------------

web-dev:
	cd web && npm run dev

web-build:
	cd web && npm run build

web-test:
	cd web && npm test

web-lint:
	cd web && npm run lint

web-typecheck:
	cd web && npm run typecheck

# --- Gates -------------------------------------------------------------------

# Everything that runs without a chain, a wallet, or a funded key.
verify:
	cd contracts && npm test
	cd web && npm run lint
	cd web && npm run typecheck
	cd web && npm test
	cd web && npm run build

clean:
	cd contracts && npm run clean
	rm -rf web/.next
