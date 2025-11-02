import type { DataProvider, CustomRequest } from "@refinedev/core";
import axios from "axios";

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "", // vite dev proxy handles /api during dev
});

export const dataProvider = (): DataProvider => ({
  getList: async () => {
    const { data } = await api.get("/api/collections");
    const rows = (data?.collections ?? []).map((c: any) => ({ id: c.name, ...c }));
    return { data: rows, total: rows.length };
  },

  getOne: async ({ id }) => {
    const { data } = await api.get(`/api/collections/${encodeURIComponent(String(id))}`);
    return { data: { id: data.name, ...data } };
  },

  create: async ({ variables }) => {
    const { data } = await api.post("/api/collections", variables);
    return { data: { id: variables?.name, ...data } };
  },

  deleteOne: async ({ id }) => {
    const { data } = await api.delete(`/api/collections/${encodeURIComponent(String(id))}`);
    return { data };
  },

  update: async () => {
    throw new Error("Update not supported");
  },

  // For /api/status, /api/rag/*, /api/sync
  custom: async (request: CustomRequest) => {
    const { url, method, headers, meta, payload, query } = request;
    const res = await api.request({
      url,
      method,
      data: payload,
      params: query,
      headers,
    });
    return { data: res.data };
  },
});
