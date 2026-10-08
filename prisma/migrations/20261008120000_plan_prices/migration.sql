-- Configurable plan prices (restiq-backend#201): one row per country and plan, edited by operators.
-- Platform-level (no tenant), like catalog_products. NULL price = "on quote".
CREATE TABLE "plan_prices" (
    "country" "Country" NOT NULL,
    "plan" "SubscriptionPlan" NOT NULL,
    "monthly_price_minor" BIGINT,
    "annual_discount_percent" INTEGER NOT NULL DEFAULT 20,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "plan_prices_pkey" PRIMARY KEY ("country", "plan"),
    CONSTRAINT "plan_prices_price_check" CHECK ("monthly_price_minor" IS NULL OR "monthly_price_minor" >= 0),
    CONSTRAINT "plan_prices_discount_check" CHECK ("annual_discount_percent" BETWEEN 0 AND 100)
);
-- Today's list prices: A$49 / A$129, ₹499 / ₹999 per outlet per month, 20% off annual.
INSERT INTO "plan_prices" ("country", "plan", "monthly_price_minor") VALUES
  ('AU', 'standard', 4900), ('AU', 'enterprise', 12900),
  ('IN', 'standard', 49900), ('IN', 'enterprise', 99900);
