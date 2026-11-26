// Offline test: typos in the client's own material are corrected in the ads (no network).
import { correctSourceTypos, typoIn } from "../lib/checker/source-proofread";
const typos = [{ where: "flyer p. 3 (Pizza)", text: "mellanolika", issue: "two words run together", suggestion: "mellan olika" }];
const issues: any[] = [
  // ad copied the typo (the ad reader flagged it)
  { severity: "warning", message: "Text: missing space", found: "Välj mellanolika sorter", expected: "Välj mellan olika sorter" },
  // ad fixed it → only difference from the flyer is the fix → dropped
  { severity: "error", product: "Pizza", message: "Info text differs from the flyer", expected: "Grandiosa. Välj mellanolika sorter. 350 g.", found: "Grandiosa. Välj mellan olika sorter. 350 g." },
  // ad fixed it but also has another difference → kept, compared with the corrected text
  { severity: "error", product: "Pizza", message: "Info text differs from the flyer", expected: "Grandiosa. Välj mellanolika sorter. 350 g.", found: "Grandiosa. Välj mellan olika sorter. 450 g." },
  // unrelated
  { severity: "error", product: "Kaffe", message: "Price differs from the flyer", expected: "49:-", found: "59:-" },
];
for (const i of correctSourceTypos(issues, typos, "Coop's flyer/manus")) console.log(i.severity, "|", i.message, "| exp:", i.expected);
console.log(!!typoIn("VÄLJ MELLANOLIKA SORTER", typos));
