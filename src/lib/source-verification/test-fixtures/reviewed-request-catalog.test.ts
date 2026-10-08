// @vitest-environment node
import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { buildStageRequest, prepareSplitInput, sha256, STAGES } from "../split-verification/contracts";

it("provides the closed offline request catalog through the portable regression boundary", async () => {
  const modulePath = "./reviewed-request-catalog";
  const catalog = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
  expect(catalog, "portable offline request catalog is missing").toBeDefined();
  if (!catalog) return;
  expect(catalog.loadCatalog).toBeTypeOf("function");
  await expect(catalog.loadCatalog()).resolves.toBe(catalog.CATALOG);
  expect(catalog.CATALOG_SHA256).toBe("2488e80193506845723e04bb5b4636cc603d7628ee7c17d82a33462fc835b1b8");
  expect(catalog.CASE_IDS).toEqual(["nine-month-control", "shared-qualifier", "limits", "missing-consent", "unknown-exclusion", "positive-application"]);
  const bytes = await readFile(new URL("./reviewed-request-catalog.json", import.meta.url));
  expect(sha256(bytes.toString("utf8"))).toBe(catalog.CATALOG_SHA256);
  await expect(catalog.loadCatalog(Buffer.from(bytes.toString("utf8") + "\n"))).rejects.toThrow("catalog_hash_drift");
  const first = catalog.caseInput("nine-month-control");
  expect(Buffer.byteLength(first.candidate)).toBe(331);
  expect(Object.isFrozen(first.evidence.passages[0].review)).toBe(true);
  expect(() => catalog.caseInput("unreviewed-case")).toThrow("catalog_case_rejected");
  expect(() => catalog.validateCaseInput("nine-month-control", { ...first, candidate: first.candidate + " " })).toThrow("catalog_input_drift");
});

it("provides the offline authored answer envelope through the portable regression boundary", async () => {
  const modulePath = "./reviewed-answer-fixtures";
  const fixtures = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
  expect(fixtures, "portable offline answer fixtures are missing").toBeDefined();
  if (!fixtures) return;
  expect(fixtures.authoredStage).toBeTypeOf("function");
  expect(fixtures.fixtureFetch).toBeTypeOf("function");
  expect(fixtures.providerEnvelope("authored")).toMatchObject({ object: "interaction", model: "gemini-3.8-flash", status: "completed", steps: [
    { type: "thought", signature: "synthetic-signature" },
    { type: "model_output", content: [{ type: "text", text: "authored" }] },
  ] });
});

// Fingerprints taken from the unchanged historical offline fixtures before extraction.
// These preserve closed regression contexts and authored outputs; they do not certify
// or repin any prior paid campaign or production runtime.
const closedParity = {
  "nine-month-control": {
    "inputSha256": "dc1aeb3342df9e081ca77ce2bef57f215bcc81db0f73fd2e1a4e6ad6881367c3",
    "contextSha256": "dc1aeb3342df9e081ca77ce2bef57f215bcc81db0f73fd2e1a4e6ad6881367c3",
    "stages": {
      "inventory": {
        "requestSha256": "6119e0912f3f7ed6b169e66ca97b48efe6d8bf6e283c01762f48ac187b06a54e",
        "outputSha256": "4cb902ba83163a53de5eef299924cb02751241e9bdd94e05cb0fcf1efefb0642",
        "envelopeSha256": "68941baeca6ad2d661df15ed4deffd24e6f68c77178ff2987609609a94c058e4"
      },
      "consent": {
        "requestSha256": "3a7fe6a6d999359653f79e55c5e095a1831ffc6f5386ff7e4311f0d0daa92239",
        "outputSha256": "5cadd8c02f6ec678338dd878087fcb9307df60a58bf406084c7e2b9fcb4fc4bd",
        "envelopeSha256": "97f51f02250f152fd84a64225130d9439804953ff98614098fbb4b94279c80ea"
      },
      "overtime": {
        "requestSha256": "41145143f13e67c8544e0d2bf87a14fc52552c6bcaa89f7191f54a909ddf6511",
        "outputSha256": "d44a489197f9150bcd0420fd7b14f1a47a50268e99a7dca66e8118aece0fe81d",
        "envelopeSha256": "810720c8140f15d9a8626f8455acbd82c9373d57bd0bf0fdb71560add401c668"
      }
    }
  },
  "shared-qualifier": {
    "inputSha256": "9db00a71a16a188aa64f0f043b7f08266243a1c57dd590a0aa76261e6edd7537",
    "contextSha256": "9db00a71a16a188aa64f0f043b7f08266243a1c57dd590a0aa76261e6edd7537",
    "stages": {
      "inventory": {
        "requestSha256": "9ac5727883dab06324c528c4937147cb0cb45a86cb867e4100452c396b756b6e",
        "outputSha256": "d2d0647d1274e64ceb2afb4fce0c3769f6500d838f87c99c23a45fea0ffd1341",
        "envelopeSha256": "af3d16e3fb080aec2810c58afd9d1baa07f50126365d256dbf2ca5f9521fcad9"
      },
      "consent": {
        "requestSha256": "557dc918c9d68c56ef1ae7a9b8c462e599f9c5d4fba4823da2c87c9a096ed84a",
        "outputSha256": "5cadd8c02f6ec678338dd878087fcb9307df60a58bf406084c7e2b9fcb4fc4bd",
        "envelopeSha256": "97f51f02250f152fd84a64225130d9439804953ff98614098fbb4b94279c80ea"
      },
      "overtime": {
        "requestSha256": "68cc55704a4d723aa91b51ef9295be24430bcc59d20411277d6c4c56e04e5e47",
        "outputSha256": "d44a489197f9150bcd0420fd7b14f1a47a50268e99a7dca66e8118aece0fe81d",
        "envelopeSha256": "810720c8140f15d9a8626f8455acbd82c9373d57bd0bf0fdb71560add401c668"
      }
    }
  },
  "limits": {
    "inputSha256": "c74f29b5a1cae585209826dc8a29d257b40e22c458e48a075ebb619d7387b6dc",
    "contextSha256": "c74f29b5a1cae585209826dc8a29d257b40e22c458e48a075ebb619d7387b6dc",
    "stages": {
      "inventory": {
        "requestSha256": "75f74b11d7f448e8e53756ef15f468ab7bd86737974ba02fb1e2e5fb3cf04f1c",
        "outputSha256": "f254e7a677f085f6982314d49afa3dc7ff18d33898c182209ae46b4e47fc8992",
        "envelopeSha256": "38937fbecbf381907a5982eb95770f42a889919598d77fc39b18f2fa793d0e96"
      },
      "consent": {
        "requestSha256": "6cbf522726e0761c382d15933aeb08757bd6f64f6f5fd5a2c4fcc6bcb0625372",
        "outputSha256": "89fb8fe1445f5b7db26f3daceda30b00c2f8e359e435e1fd7f8e163e0205353e",
        "envelopeSha256": "8580ef384d7a0a3d57882d5150980bbbb931a266b7090d9f0896b40638b3f0c8"
      },
      "overtime": {
        "requestSha256": "f0fed6d3f4601b5205ab0a6dc20ddbf19dcfbd8fc36f321e108156a3522abd3f",
        "outputSha256": "1fd7a67203c371f7054053a04abaecf9bc615d789bee1543d408da35ea655984",
        "envelopeSha256": "907f0326b95dc4ae9463b4feaa82550998ecbc4548410089f71ef9ac202c04ac"
      }
    }
  },
  "missing-consent": {
    "inputSha256": "954f2ec1152a2c0807035fa76fbbbb1480b076b61c9abaaa768f074a6a503f9a",
    "contextSha256": "954f2ec1152a2c0807035fa76fbbbb1480b076b61c9abaaa768f074a6a503f9a",
    "stages": {
      "inventory": {
        "requestSha256": "0efa2e4c52947cbe2c3e0e65a794de5e3047c5ab4c9b9c1135e9fab56c4a18a2",
        "outputSha256": "33f974e15151620fe41983bd9b126b44abbcfb60b74c86f310fd0098d4a9792e",
        "envelopeSha256": "d28b55400738868d564d552e00da9b47633a4b4e3be5a665489d4b9bc1632042"
      },
      "consent": {
        "requestSha256": "890fa098f33296dbf799aa15da48f0c856ca060a5d45aff6905b42b848b5a007",
        "outputSha256": "5cadd8c02f6ec678338dd878087fcb9307df60a58bf406084c7e2b9fcb4fc4bd",
        "envelopeSha256": "97f51f02250f152fd84a64225130d9439804953ff98614098fbb4b94279c80ea"
      },
      "overtime": {
        "requestSha256": "92b691f06cb8c325433fa417b006dc1ffebb9b88e655f627ec50a6460f6acb17",
        "outputSha256": "d44a489197f9150bcd0420fd7b14f1a47a50268e99a7dca66e8118aece0fe81d",
        "envelopeSha256": "810720c8140f15d9a8626f8455acbd82c9373d57bd0bf0fdb71560add401c668"
      }
    }
  },
  "unknown-exclusion": {
    "inputSha256": "b296961400827f568cbfef5ac6e466b89fca1daa86467dfbf5c5c2eeebccee0f",
    "contextSha256": "b296961400827f568cbfef5ac6e466b89fca1daa86467dfbf5c5c2eeebccee0f",
    "stages": {
      "inventory": {
        "requestSha256": "fa3fb59658c5cbeaa41cb7d6d11c3ac2e00636388531d2fd7596273a6bacfb6f",
        "outputSha256": "8e235e8dabf877caaf653263d91c4a1dad165518356f08c3fdc994437597818f",
        "envelopeSha256": "e39f216bb44ef39ea4a3f6eeede4c3ad3afc0daefd5b761cdda5cf4261f1198d"
      },
      "consent": {
        "requestSha256": "8e1b2ee352e5c8a4af182be19bd961b0626571866d183d981f64f76ecfd55b0b",
        "outputSha256": "5cadd8c02f6ec678338dd878087fcb9307df60a58bf406084c7e2b9fcb4fc4bd",
        "envelopeSha256": "97f51f02250f152fd84a64225130d9439804953ff98614098fbb4b94279c80ea"
      },
      "overtime": {
        "requestSha256": "c37ac33fe67b02533ded0e20f8394ba53e485018fb762ef2c20a8541ae6b6a57",
        "outputSha256": "d44a489197f9150bcd0420fd7b14f1a47a50268e99a7dca66e8118aece0fe81d",
        "envelopeSha256": "810720c8140f15d9a8626f8455acbd82c9373d57bd0bf0fdb71560add401c668"
      }
    }
  },
  "positive-application": {
    "inputSha256": "6d39d911ad7c5797e35192595b81dbf3e00dccbabdb30c7a7dd6f532c479ea26",
    "contextSha256": "6d39d911ad7c5797e35192595b81dbf3e00dccbabdb30c7a7dd6f532c479ea26",
    "stages": {
      "inventory": {
        "requestSha256": "c95b30f022f45808c081926c1ae767637ea6d0965e83abbeb1e7e0febdbeedac",
        "outputSha256": "5485a6a80b01f4f56fe1be972e4365883df86bd0425ef8e1842fad1b1d7c7ecf",
        "envelopeSha256": "54accab6e27a671eb4e8b80d0d64b2ea455620d596149c836ce6f50785cef971"
      },
      "consent": {
        "requestSha256": "5e0ff7b11f28c37813445d3eaa476c4c2a6e3c5d0cccc111bd396c2b5f5da61b",
        "outputSha256": "5cadd8c02f6ec678338dd878087fcb9307df60a58bf406084c7e2b9fcb4fc4bd",
        "envelopeSha256": "97f51f02250f152fd84a64225130d9439804953ff98614098fbb4b94279c80ea"
      },
      "overtime": {
        "requestSha256": "faaee43104219d36419c8218999c9511027c0492e234d7e3cde2cc6acfdb3dc2",
        "outputSha256": "d44a489197f9150bcd0420fd7b14f1a47a50268e99a7dca66e8118aece0fe81d",
        "envelopeSha256": "810720c8140f15d9a8626f8455acbd82c9373d57bd0bf0fdb71560add401c668"
      }
    }
  }
} as const;

it.each(Object.entries(closedParity))("preserves exact offline request and answer bytes for %s", async (caseId, expected) => {
  const catalogPath = "./reviewed-request-catalog", fixturePath = "./reviewed-answer-fixtures";
  const catalog = await import(/* @vite-ignore */ catalogPath).catch(() => undefined);
  const fixtures = await import(/* @vite-ignore */ fixturePath).catch(() => undefined);
  expect(catalog, "portable offline request catalog is missing").toBeDefined();
  expect(fixtures, "portable offline answer fixtures are missing").toBeDefined();
  if (!catalog || !fixtures) return;
  const input = catalog.caseInput(caseId), prepared = prepareSplitInput(input)!;
  expect(sha256(JSON.stringify(input))).toBe(expected.inputSha256);
  expect(prepared.contextSha256).toBe(expected.contextSha256);
  const inventoryRequest = buildStageRequest(prepared, "inventory", "fixture-closed-request", 90000)!;
  const inventory = fixtures.authoredStage(inventoryRequest);
  for (const stage of STAGES) {
    const request = stage === "inventory" ? inventoryRequest
      : buildStageRequest(prepared, stage, "fixture-closed-request", 90000, inventory)!;
    const output = fixtures.authoredStage(request), envelope = fixtures.providerEnvelope(JSON.stringify(output));
    expect(sha256(JSON.stringify(request))).toBe(expected.stages[stage].requestSha256);
    expect(sha256(JSON.stringify(output))).toBe(expected.stages[stage].outputSha256);
    expect(sha256(JSON.stringify(envelope))).toBe(expected.stages[stage].envelopeSha256);
    const body = JSON.stringify({ input: JSON.stringify(request.data), system_instruction: request.systemInstruction });
    const response = await fixtures.fixtureFetch()("https://offline-fixture.invalid", { body });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(envelope);
  }
});
