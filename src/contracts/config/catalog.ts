import { z } from 'zod';

/** Prices are integers in minor units with an explicit currency (specs/003). */
export const Money = z.object({
  amount: z.number().int().nonnegative().describe('Minor units, e.g. cents.'),
  currency: z.string().length(3).describe('ISO 4217, e.g. ARS, USD.'),
});
export type Money = z.infer<typeof Money>;

export const OfferingSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  price: Money,
  // Optional: a product has neither, and a required null is a course-shaped
  // hole every other tenant would have to fill (specs/042).
  durationHours: z.number().positive().nullable().default(null),
  schedule: z.string().nullable().default(null),
  url: z.string().url().nullable().default(null),
});
export type Offering = z.infer<typeof OfferingSchema>;

/**
 * A way to pay the tenant has published: instalments, a deposit, a
 * private-class rate. A catalog fact the agent may present, not a negotiation
 * (specs/023 § Objections are answered from the catalog).
 */
export const PaymentOptionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
});
export type PaymentOption = z.infer<typeof PaymentOptionSchema>;

export const CatalogSchema = z.object({
  businessName: z.string().min(1),
  currency: z.string().length(3),
  offerings: z.array(OfferingSchema).min(1),
  faq: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),
  paymentOptions: z
    .array(PaymentOptionSchema)
    .default([])
    .refine(
      options => new Set(options.map(option => option.id)).size === options.length,
      'payment option ids must be unique',
    ),
});
export type Catalog = z.infer<typeof CatalogSchema>;
