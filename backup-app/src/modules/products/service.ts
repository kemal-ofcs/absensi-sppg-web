import { and, desc, eq, isNull } from "drizzle-orm";
import { getDatabase } from "@/core/db/connection";
import { products, type Product } from "@/core/db/schema";
import { isTauri } from "@/core/env";
import { getSyncDeviceId } from "@/lib/sync/device";
import {
  pendingSoftDeleteMetadata,
  pendingSyncMetadata,
} from "@/lib/sync/mutation";
import type { CreateProductInput, UpdateProductInput } from "./types";

async function resolveNodeId(): Promise<string> {
  if (isTauri()) {
    try {
      return await getSyncDeviceId();
    } catch {
      return "desktop-local";
    }
  }
  return "web-server";
}

export async function listProducts(includeDeleted = false): Promise<Product[]> {
  const db = await getDatabase();
  if (includeDeleted) {
    return db.select().from(products).orderBy(desc(products.createdAt));
  }
  return db
    .select()
    .from(products)
    .where(isNull(products.deletedAt))
    .orderBy(desc(products.createdAt));
}

export async function getProductById(id: string): Promise<Product | null> {
  const db = await getDatabase();
  const rows = await db
    .select()
    .from(products)
    .where(eq(products.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function createProduct(input: CreateProductInput): Promise<Product> {
  const db = await getDatabase();
  const nodeId = await resolveNodeId();
  const id = crypto.randomUUID();
  const sync = pendingSyncMetadata({ nodeId });

  const newRecord = {
    id,
    sku: input.sku,
    name: input.name,
    category: input.category || "General",
    price: input.price,
    stock: input.stock,
    isActive: input.isActive,
    ...sync,
  };

  await db.insert(products).values(newRecord);
  const created = await getProductById(id);
  if (!created) {
    throw new Error("Gagal membuat produk baru.");
  }
  return created;
}

export async function updateProduct(input: UpdateProductInput): Promise<Product> {
  const db = await getDatabase();
  const existing = await getProductById(input.id);
  if (!existing) {
    throw new Error(`Produk dengan ID '${input.id}' tidak ditemukan.`);
  }

  const nodeId = await resolveNodeId();
  const sync = pendingSyncMetadata({
    current: { version: existing.version, hlc: existing.hlc },
    nodeId,
  });

  await db
    .update(products)
    .set({
      ...(input.sku ? { sku: input.sku } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.category ? { category: input.category } : {}),
      ...(input.price !== undefined ? { price: input.price } : {}),
      ...(input.stock !== undefined ? { stock: input.stock } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...sync,
    })
    .where(eq(products.id, input.id));

  const updated = await getProductById(input.id);
  if (!updated) {
    throw new Error("Gagal memperbarui data produk.");
  }
  return updated;
}

export async function deleteProduct(id: string): Promise<void> {
  const db = await getDatabase();
  const existing = await getProductById(id);
  if (!existing) {
    throw new Error(`Produk dengan ID '${id}' tidak ditemukan.`);
  }

  const nodeId = await resolveNodeId();
  const sync = pendingSoftDeleteMetadata({
    current: { version: existing.version, hlc: existing.hlc },
    nodeId,
  });

  await db.update(products).set(sync).where(eq(products.id, id));
}
