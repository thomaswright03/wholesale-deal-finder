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

## Rental or flip

Each lead gets a **Deal type**. If RentCast values the house (as-is value, used as the after-repair value) and the list price is under 80% of that value, it's marked **Flip** (probably needs work); otherwise **Rental** (probably already fixed up). This is a guess from price, not photos, so check the photos.

- Rental: the buyer's year-one cash-on-cash return goes in **Rental: buyer cash-on-cash**.
- Flip: **Flip: buyer profit** = value − buyer's price − rehab (sqft × $30) − 10% of value for closing, holding and selling.

All three numbers are in `config.json` under `flip`. Leads are still picked by the rental rules; the flip number is extra information. The value lookup is 1 more API call per promising home.

## Live mortgage rate

Every run pulls today's 30-year fixed rate from FRED (St. Louis Fed): the Optimal Blue 30-year conforming index (updated every business day), falling back to Freddie Mac's weekly survey, then to `buyer.interestRate` in config.json. The rate and its source are on the spreadsheet's Assumptions sheet. Set `"liveMortgageRate": false` in config.json to use the fixed number instead.

## Daily schedule and where results land

The workflow runs every day at 11:00 UTC. With rent coming from your script, a day costs about 1 RentCast call for the listing search plus tax/value lookups for the most promising homes, capped at 4 per run and 45 per billing period (`maxApiCallsPerRun`, `maxApiCallsPerMonth`). Once the period's calls are used it makes 0 calls and reuses the last scan.

Every run commits the newest results to `latest/leads.xlsx` and `latest/cards.html`. To email them each morning, add repo secrets `MAIL_USERNAME` and `MAIL_PASSWORD` (a Gmail address and an app password for it) and `MAIL_TO` (comma-separated recipients). Without those secrets the email step is skipped.

A typical day: 6 AM scan → `rents/needed.json` and `photos/needed.json` update → you run your rent and photo scripts and push → the push reruns the deal math and rates new photos → `latest/` updates.

## Rent from your own script

`config.json` → `"rentSource": "file"` means RentCast is never asked for rent. Each run writes `rents/needed.json` (every listing that passes the filters, with a `key`, address, beds, baths, sqft and `hasRent`). Your script writes `rents/rents.json` as `{ "<key>": { "rent": 1450, "low": 1300, "high": 1600 } }` and pushes; the push reruns the workflow with 0 RentCast calls. See `rents/README.txt`. An entry can also carry `"value"` (as-is value / ARV, fills Flip profit) and `"tax"` (the actual annual property tax bill, replaces any estimate). Set `"rentSource": "rentcast"` to go back (rents.json still overrides RentCast where present). RentCast is still used for the listing search, tax record and value estimate.

## Condition from photos (Claude) + Home Restoration AI pricing

Claude rates each of 18 areas of the house (kitchen, bathrooms, flooring, roof, HVAC, ...) as none / light / medium / heavy work from the photos, inferring the ones photos don't show from age and overall condition. The rehab cost is then priced by Home Restoration AI's whole-home model (`vendor/home-restoration/`, copied from `~/repos/Home-Restoration-AI`): labor + materials, 2% permits, 10% contingency. The spreadsheet shows the total (Rehab estimate), a range, and the breakdown by area; the cards show the breakdown too. To change unit costs, edit `DEFAULT_HOME_PRICES` there and copy the three files over again.

### Details

Commit a house's listing photos to `photos/<folder>/` in this repo (jpg, png, webp or gif, under 5 MB each). The folder name is the address with dashes, e.g. `photos/238-Helen-St-Cincinnati-OH-45219/`. Every run writes `out/photo-folders.txt` with the exact folder name for each lead.

Pushing to `photos/` starts the GitHub workflow by itself with no RentCast calls: it reuses the last scan's listings (`data/listings.json` in the Actions cache, or `seed/listings.json` until a new scan runs) and rates the new photos. Each lead with photos is sent to Claude (`claude-sonnet-5-5`, set in config.json under photos.model; up to 10 photos per house, sorted by file name) and rated **Rental-ready / Light / Medium / Heavy rehab** with a rehab dollar estimate, a confidence and a short note. That rating replaces the price-based guess: rental-ready = Rental, anything else = Flip, and Claude's rehab estimate replaces the $30/sqft number in Flip profit. The spreadsheet gets Condition, Photo confidence, Photo notes and Photo folder columns; the cards show the rating and the note.

- Needs the `ANTHROPIC_API_KEY` repo secret (Settings → Secrets and variables → Actions). Use a key from the Console org that holds the promotional credit.
- Ratings are cached in `data/ratings.json`; the same photos are never rated twice. Adding or changing photos re-rates that house.
- At most `photos.maxHousesPerRun` (25) new ratings per run. Roughly $0.05 to $0.10 per house at 10 photos (estimate).
- Running the workflow by hand with limit `0` does the same thing: no RentCast calls, just re-rate and rebuild the spreadsheet.

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

## API budget

RentCast charges per call. `config.json` caps it: `maxApiCallsPerRun` and `maxApiCallsPerMonth` (both 45, under the free Developer plan's 50, so it never bills overage). When the cap is hit the run stops looking things up and finishes the rest on later runs, longest-listed homes first. Raise both numbers when you move to a paid plan (Foundation: 1,000/month).

Calls per home: 1 for rent, plus 1 for the county tax record only if the home looks like it could work with an estimated tax bill. Listings cost 1 call per 500.

## Data source

[RentCast](https://developers.rentcast.io) gives listings (with listing agent name and phone), rent estimates (median + range) and county tax records with one key. Rent and tax are cached in `data/cache.json` for 30 days, so after the first run a market only costs calls for new listings.

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
