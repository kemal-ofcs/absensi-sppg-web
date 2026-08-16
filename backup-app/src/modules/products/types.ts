import { z } from "zod";

export const createProductInputSchema = z.object({
  sku: z.string().trim().min(1, "SKU tidak boleh kosong").max(100),
  name: z.string().trim().min(1, "Nama produk tidak boleh kosong").max(200),
  category: z.string().trim().min(1).max(100).default("General"),
  price: z.number().int().nonnegative("Harga harus bernilai positif"),
  stock: z.number().int().default(0),
  isActive: z.boolean().default(true),
});

export type CreateProductInput = z.infer<typeof createProductInputSchema>;

export const updateProductInputSchema = createProductInputSchema.partial().extend({
  id: z.string().min(1),
});

export type UpdateProductInput = z.infer<typeof updateProductInputSchema>;
