INPUT for a photo downloader:  photos/needed.json
  {"houses": [{"address": "238 Helen St, Cincinnati, OH 45219", "street", "city", "state", "zip",
               "folder": "photos/238-Helen-St-Cincinnati-OH-45219", "hasPhotos": false, "rated": false, "tier": "A"}]}
  Rewritten by every GitHub run. Only houses with "hasPhotos": false still need photos.

OUTPUT: save each house's photos into its "folder", exactly as written, relative to the repo root.
  photos/238-Helen-St-Cincinnati-OH-45219/01.jpg, 02.jpg, ...
  - .jpg .jpeg .png .webp or .gif, each under 5 MB (bigger files are skipped)
  - The first 10 by file name are used, so name them 01, 02, ... in listing order
  - Then commit and push to main. That starts the workflow, which rates them (0 RentCast calls).
