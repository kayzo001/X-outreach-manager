import "dotenv/config";
import { rescoreContacts } from "../src/lib/scoring";
rescoreContacts().then((n) => { console.log(`scored ${n} contacts`); process.exit(0); });
