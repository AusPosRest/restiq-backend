# Guest cart API

The standalone OpenAPI contract is in `openapi/guest-cart.yaml`. Guest bearer authentication and existing cart ownership/session rules apply. Validation failures return HTTP 400 with `{ error: { code: "validation_failed", message } }`.

`note` is optional on POST `/guest/v1/cart/lines` and PATCH `/guest/v1/cart/lines/{id}`. It is trimmed before the 200-character limit is checked; blank or null clears it. Omission on PATCH preserves it. Cart responses always include `note` (string or null). Each add creates a separate line, including the same item with and without notes. POST `/guest/v1/orders` copies cart notes to `OrderLine.note`, which the kitchen queue already exposes.
