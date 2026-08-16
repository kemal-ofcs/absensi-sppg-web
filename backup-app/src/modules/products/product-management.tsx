"use client";

import { useEffect, useState } from "react";
import { Package, Plus, RefreshCw, ShoppingCart, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Product } from "@/core/db/schema";
import { createProduct, deleteProduct, listProducts } from "./service";

export function ProductManagement() {
  const [items, setItems] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);

  // Form state
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Minuman");
  const [price, setPrice] = useState("15000");
  const [stock, setStock] = useState("50");
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const loadData = async () => {
    setLoading(true);
    setErrorMsg("");
    try {
      const data = await listProducts();
      setItems(data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Gagal memuat produk";
      setErrorMsg(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sku.trim() || !name.trim()) return;

    setSaving(true);
    setErrorMsg("");
    try {
      await createProduct({
        sku: sku.trim(),
        name: name.trim(),
        category: category.trim() || "General",
        price: Number(price) || 0,
        stock: Number(stock) || 0,
        isActive: true,
      });
      setSku("");
      setName("");
      setShowAddForm(false);
      await loadData();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Gagal menyimpan produk";
      setErrorMsg(message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteProduct(id);
      await loadData();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Gagal menghapus produk";
      setErrorMsg(message);
    }
  };

  return (
    <Card className="border-zinc-800 bg-zinc-900 text-zinc-100 shadow-xl">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div>
          <div className="flex items-center gap-2">
            <Package className="h-5 w-5 text-cyan-400" />
            <CardTitle className="text-lg">Modul Produk (Contoh POS / Hybrid Sync)</CardTitle>
          </div>
          <CardDescription className="text-zinc-400">
            Setiap mutasi produk otomatis menandai status sync `pending` dan siap disinkronisasi ke Turso Cloud.
          </CardDescription>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void loadData()}
            disabled={loading}
            className="border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => setShowAddForm(!showAddForm)}
            className="bg-cyan-600 text-white hover:bg-cyan-500"
          >
            <Plus className="h-4 w-4 mr-1" />
            {showAddForm ? "Tutup Form" : "Tambah Produk"}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {errorMsg && (
          <div className="rounded border border-red-800/60 bg-red-950/40 p-3 text-xs text-red-300">
            {errorMsg}
          </div>
        )}

        {showAddForm && (
          <form
            onSubmit={handleCreate}
            className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4 space-y-3"
          >
            <h4 className="text-sm font-semibold text-zinc-200">Tambah Produk Baru</h4>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <div>
                <Label className="text-xs text-zinc-400">SKU / Barcode</Label>
                <Input
                  value={sku}
                  onChange={(e) => setSku(e.target.value)}
                  placeholder="PRD-001"
                  required
                  className="border-zinc-700 bg-zinc-900 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs text-zinc-400">Nama Produk</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Kopi Susu Gula Aren"
                  required
                  className="border-zinc-700 bg-zinc-900 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs text-zinc-400">Kategori</Label>
                <Input
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="Minuman"
                  className="border-zinc-700 bg-zinc-900 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs text-zinc-400">Harga (Rp)</Label>
                <Input
                  type="number"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="15000"
                  className="border-zinc-700 bg-zinc-900 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs text-zinc-400">Stok</Label>
                <Input
                  type="number"
                  value={stock}
                  onChange={(e) => setStock(e.target.value)}
                  placeholder="50"
                  className="border-zinc-700 bg-zinc-900 text-sm"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowAddForm(false)}
              >
                Batal
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={saving}
                className="bg-emerald-600 text-white hover:bg-emerald-500"
              >
                {saving ? "Menyimpan..." : "Simpan Produk"}
              </Button>
            </div>
          </form>
        )}

        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-800 bg-zinc-950/60 text-xs uppercase text-zinc-400">
              <tr>
                <th className="px-4 py-3">SKU</th>
                <th className="px-4 py-3">Nama Produk</th>
                <th className="px-4 py-3">Kategori</th>
                <th className="px-4 py-3 text-right">Harga</th>
                <th className="px-4 py-3 text-center">Stok</th>
                <th className="px-4 py-3 text-center">Sync Status</th>
                <th className="px-4 py-3 text-center">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-zinc-500">
                    <ShoppingCart className="mx-auto h-8 w-8 opacity-40 mb-2" />
                    Belum ada produk. Klik "Tambah Produk" untuk membuat data pertama.
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr key={item.id} className="hover:bg-zinc-800/30 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-cyan-300">{item.sku}</td>
                    <td className="px-4 py-3 font-medium text-zinc-100">{item.name}</td>
                    <td className="px-4 py-3 text-zinc-400">{item.category}</td>
                    <td className="px-4 py-3 text-right font-mono text-emerald-400">
                      Rp {Number(item.price).toLocaleString("id-ID")}
                    </td>
                    <td className="px-4 py-3 text-center font-mono">{item.stock}</td>
                    <td className="px-4 py-3 text-center">
                      <Badge
                        variant={item.syncStatus === "synced" ? "default" : "secondary"}
                        className={
                          item.syncStatus === "synced"
                            ? "bg-emerald-950 text-emerald-300 border-emerald-800"
                            : "bg-amber-950 text-amber-300 border-amber-800"
                        }
                      >
                        {item.syncStatus} (v{item.version})
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => handleDelete(item.id)}
                        className="text-red-400 hover:bg-red-950/50 hover:text-red-300"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
