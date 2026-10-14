/**
 * EU / generic — a minimal built-in pack (P8 stage 7): the most common
 * English, German, Polish, French, Spanish and Italian shop words, a few
 * bank-operation phrases, international payment channels and EU-wide ID
 * types. A proof of the format more than a full dictionary; it is OFF until
 * the person turns it on.
 */
import type { CountryPack } from "./index";

export const EU_PACK: CountryPack = {
  format: "finlynq-country-pack",
  version: 1,
  id: "eu",
  country: "EU",
  locale: "en",
  name: "EU / generic",
  typeWords: [
    ...["supermarket", "supermarkt", "supermercado", "supermercato", "sklep", "markt", "épicerie", "lebensmittel"].map((word) => ({ word, type: "grocery" })),
    ...["apotheke", "pharmacie", "farmacia", "drogerie"].map((word) => ({ word, type: "pharmacy" })),
    ...["tankstelle", "stacja paliw", "station service", "gasolinera", "distributore"].map((word) => ({ word, type: "fuel" })),
    ...["gasthaus", "restauracja", "ristorante", "brasserie", "trattoria"].map((word) => ({ word, type: "restaurant" })),
    ...["kawiarnia", "café bar", "konditorei", "bäckerei", "boulangerie", "panadería"].map((word) => ({ word, type: "cafe" })),
    ...["hotel garni", "pension", "albergo", "auberge"].map((word) => ({ word, type: "hotel" })),
  ],
  bankOperations: ["kontoführung*", "opłata za prowadzenie*", "frais bancaires", "comisión*", "commissione*", "zinsen", "odsetki", "intérêts"],
  channels: ["PayPal", "Klarna", "SumUp", "Stripe", "Adyen", "Revolut"],
  idTypes: ["eu_vat", "iban", "card_last4"],
  transliteration: [],
};
