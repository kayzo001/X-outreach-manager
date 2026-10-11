// Generates samples/founders-300.csv — fictional data only, with deliberate duplicates and invalid rows.
import { writeFileSync } from "fs";
const cats = ["Design tool", "AI writing", "Analytics", "No-code", "Email marketing", "Fintech", "Creator tools", "Dev tools"];
const first = ["Alex", "Sam", "Jordan", "Riley", "Casey", "Morgan", "Taylor", "Jamie", "Avery", "Quinn"];
const rows = ["username,founder_name,company,website,mrr,industry,location,followers,bio,notes,source_url,consent_status"];
for (let i = 1; i <= 296; i++) {
  const u = `founder_${String(i).padStart(3, "0")}`;
  const form = i % 11 === 0 ? `@${u.toUpperCase()}` : i % 13 === 0 ? `https://x.com/${u}` : i % 17 === 0 ? `twitter.com/${u}/` : u;
  rows.push(`${form},${first[i % 10]} Founder${i},Startup${i},https://startup${i}.example,${[0, 2500, 8000, 12000, 30000][i % 5] || ""},${cats[i % 8]},Remote,${500 + i * 13},"Founder of Startup${i}. Building SaaS.",,https://example.com/list/${i},${i % 7 === 0 ? "yes" : ""}`);
}
rows.push("founder_005,Duplicate Of Five,Dup Co,,,,,,,,,", "@Founder_010,Dup Ten,Dup Co,,,,,,,,,", "bad name!,Bad,Bad Co,,,,,,,,,", "https://example.com/nope,Bad,Bad Co,,,,,,,,,");
writeFileSync("samples/founders-300.csv", rows.join("\n") + "\n");
console.log(`wrote ${rows.length - 1} data rows`);
