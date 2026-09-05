import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { artifacts } from "hardhat";

/**
 * Exports the ABIs the frontend consumes into `web/lib/abi/`. Only ABIs are written - bytecode and
 * build metadata stay in `contracts/artifacts/`.
 */
const EXPORTS: Array<{ contract: string; file: string; optional?: boolean }> = [
  { contract: "NimSealEscrow", file: "NimSealEscrow.json" },
];

async function main() {
  const outDir = join(__dirname, "..", "..", "web", "lib", "abi");
  mkdirSync(outDir, { recursive: true });

  for (const { contract, file } of EXPORTS) {
    let artifact;
    try {
      artifact = await artifacts.readArtifact(contract);
    } catch {
      console.warn(`Skipped ${contract}: no compiled artifact in contracts/. `);
      continue;
    }
    const target = join(outDir, file);
    writeFileSync(target, `${JSON.stringify(artifact.abi, null, 2)}\n`, "utf8");
    console.log(`Wrote ${target} (${artifact.abi.length} entries)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
