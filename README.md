# Wholesale deal finder

Every day, for each market in `config.json`, this pulls active agent-listed single-family and multi-family homes between $50k and $300k, gets the market median rent and the county tax bill for each one, and runs the rental deal math. The homes that work go into a spreadsheet and a page of call cards.

## The math (rentals)

For each listing it finds the most an end buyer can pay and still get a **20% cash-on-cash return in year one**:

- Cash in = 20% down + 3% closing costs
- Year-one cash flow = 12 × (median rent × 80% − mortgage − tax/12 − insurance/12)
- Mortgage: 30-year fixed at 7.6%, 80% loan
- Insurance: landlord policy estimate, the greater of $1,000/yr or 0.6% of list (no free source for real quotes)

**Buyer max price** = the lower of that price and list minus the buffer ($12k under $100k, $20k for $100k to $200k, $25k for $200k to $250k, $30k above).

- **Floor offer** = 70% of list (what you open with)
- **Ceiling offer** = buyer max price minus your minimum assignment fee ($8k)
- A listing qualifies when the ceiling is at or above the floor.
- Tier by the room between floor and ceiling as a share of list: **A** 10%+, **B** 4%+, **C** under 4%.
- Homes with an HOA are skipped. Foreclosure/auction listings are skipped.

Every number above is in `config.json`. Change it there; nothing else needs to change.

## Run it

```
npm install
cp .env.example .env        # add a RentCast API key
npm start                   # all markets in config.json
node src/run.ts --market "Dayton, OH"
npm run sample              # try it on tests/sample.csv, no key needed
npm test
```

Output goes to `out/`: `leads-YYYY-MM-DD.xlsx` (Leads, Skipped with the reason, Assumptions) and `cards-YYYY-MM-DD.html` / `latest.html` (open in a browser; Call, Text, Photos, mark Contacted/Skip, notes saved in the browser).

**Checking rent on Zillow:** each card has a "Check rent on Zillow" button. It copies the address and opens Zillow's [Price My Rental](https://www.zillow.com/rental-manager/price-my-rental/) page. Type the median rent you see into the card and the offers recalculate with the same math (from `src/deal.ts`). If the rent kills the deal, the card says why. This is done by hand on purpose: scraping Zillow breaks their terms and gets blocked.

## Daily run on GitHub

`.github/workflows/daily.yml` runs every morning at 11:00 UTC (6 AM Eastern) and can be started by hand from the Actions tab ("Run workflow", optionally with one market). It needs the repo secret `RENTCAST_API_KEY` (Settings → Secrets and variables → Actions). Each run's spreadsheet and cards are attached to the run as a download called `leads-<number>`, kept 30 days. The rent/tax cache carries over between runs.

## Data source

[RentCast](https://developers.rentcast.io) gives listings (with listing agent name and phone), rent estimates (median + range) and county tax records with one key. Rent and tax are cached in `data/cache.json` for 30 days, so after the first run a market only costs calls for new listings: 1 call per 500 listings, plus 2 calls per new listing.

You can also run from any CSV (an MLS export works): `node src/run.ts --csv file.csv`. Needed columns: address, city, state, price. Optional: zip, propertyType, beds, baths, sqft, hoa, rent, tax, insurance, dom, agent, agentPhone, agentEmail, url.

## Zillow rent lookup (tools/rent.py)

Your script: opens Zillow's Price My Rental in a visible Chrome window, types the address, and prints the median rent. If a CAPTCHA appears you clear it by hand.

```
python3 tools/rent.py "6823 Betts Ave, Cincinnati, OH 45239"
```

Put the number in the card's Zillow rent box and the offers recalculate. Changes from the pasted version: uses installed Google Chrome (`channel="chrome"`), so no Chromium download, and the example zip is 45239.

## Not done yet

- Not yet run against the live RentCast API (no key here). The endpoint shapes follow their docs.
- Condition / rehab estimate: not automated. The card's Photos button opens the Zillow page so you judge it by eye. Fix-and-flip math isn't in yet; this is rentals only.
