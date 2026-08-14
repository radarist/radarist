// Side-effect module: loads .env.local into process.env at *this* module's
// init time. Import as the FIRST line of any tsx script that uses static
// imports of `@/lib/firebase` or anything that reads env at module init —
// those imports get hoisted above body code, so a body-level
// `dotenv.config(...)` runs too late and Firebase initializes with an empty
// apiKey, throwing `auth/invalid-api-key`.
//
// Usage:
//   import './load-env-local';      // MUST be the first import
//   import { db } from '@/lib/firebase';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
