# POS order line payment protection (#234)

Extends the POS contract for:

- `DELETE /pos/v1/orders/{orderId}/lines/{lineId}`
- `PATCH /pos/v1/orders/{orderId}/lines/{lineId}` when quantity or selected modifier price decreases
- `POST /pos/v1/orders/{orderId}/lines/{lineId}/void` (manager PIN)

These operations return **409 Conflict** when the order's open bill has any tender, active payment intent or paid bill share, using the existing error envelope:

```json
{
  "error": {
    "code": "bill_has_payments",
    "message": "Payment has been taken on this bill. Refund or reverse it before changing lines."
  }
}
```

Failed, cancelled or expired intents and outstanding unpaid shares do not block these operations. Shares with a paid timestamp also protect the bill; outstanding share amounts are recalculated at payment time. Discard retains its count-everything rule. Existing authorization, closed-order, kitchen and combo restrictions still apply. Adding lines, increasing quantity and changing non-price metadata remain allowed under those existing restrictions.

The guard takes the bill row lock and reads payment counts inside the line mutation transaction. Payment-intent creation takes the same lock before refreshing totals and validating the requested amount. No request fields or successful response shapes change.
