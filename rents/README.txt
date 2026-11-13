Rent from your own script (config.json "rentSource": "file" = RentCast is never asked for rent).

INPUT:  rents/needed.json   (rewritten by every GitHub run)
  {"houses": [{"key": "238-Helen-St-Cincinnati-OH-45219", "address": "238 Helen St, Cincinnati, OH 45219",
               "street", "city", "state", "zip", "propertyType", "beds", "baths", "sqft", "listPrice", "hasRent": false}]}
  Look up the houses with "hasRent": false.

OUTPUT: rents/rents.json    (your script writes this; keep old entries, add new ones)
  {
    "238-Helen-St-Cincinnati-OH-45219": { "rent": 3300, "low": 3000, "high": 3600 },
    "3235-Wold-Ave-Cincinnati-OH-45207": { "rent": 2380 }
  }
  - Key = the "key" from needed.json, copied exactly.
  - "rent" = median monthly rent in dollars (number, no $ or commas). "low"/"high" optional.
  - Commit and push to main. That reruns the deal math on GitHub (0 RentCast calls).
