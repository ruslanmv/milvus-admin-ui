import { Refine } from "@refinedev/core";
import {
  ThemedLayoutV2,
  notificationProvider,
  ErrorComponent,
  RefineThemes,
} from "@refinedev/antd";
import "@refinedev/antd/dist/reset.css";
import { BrowserRouter, Routes, Route, Outlet, Navigate, Link } from "react-router-dom";
import { ConfigProvider, theme as antdTheme } from "antd";
import { dataProvider } from "./dataProvider";

import Status from "./pages/status/Status";
import CollectionsList from "./pages/collections/list";
import CollectionsCreate from "./pages/collections/create";
import Rag from "./pages/rag/Rag";
import Notes from "./pages/notes/Notes";

// Simple header (no buttons; navigation via left sidebar)
const HeaderTitle = () => {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <Link to="/status" style={{ fontWeight: 700, fontSize: 18, color: "inherit" }}>
        Milvus Admin
      </Link>
    </div>
  );
};

export default function App() {
  // Vivid primary + subtle radius
  const customTheme = {
    ...RefineThemes.Blue,
    token: {
      ...RefineThemes.Blue.token,
      colorPrimary: "#2563eb",
      borderRadius: 10,
    },
    algorithm: antdTheme.defaultAlgorithm,
  };

  return (
    <BrowserRouter>
      <ConfigProvider theme={customTheme}>
        <Refine
          dataProvider={dataProvider()}
          notificationProvider={notificationProvider}
          resources={[
            { name: "status", list: "/status", meta: { label: "Status" } },
            { name: "collections", list: "/collections", create: "/collections/create" },
            { name: "rag", list: "/rag", meta: { label: "RAG" } },
            { name: "notes", list: "/notes", meta: { label: "Notes" } },
          ]}
          options={{ syncWithLocation: true }}
        >
          <Routes>
            <Route
              element={
                <ThemedLayoutV2 Title={HeaderTitle}>
                  <Outlet />
                </ThemedLayoutV2>
              }
            >
              <Route index element={<Navigate to="/status" replace />} />
              <Route path="/status" element={<Status />} />
              <Route path="/collections">
                <Route index element={<CollectionsList />} />
                <Route path="create" element={<CollectionsCreate />} />
              </Route>
              <Route path="/rag" element={<Rag />} />
              <Route path="/notes" element={<Notes />} />
              <Route path="*" element={<ErrorComponent />} />
            </Route>
          </Routes>
        </Refine>
      </ConfigProvider>
    </BrowserRouter>
  );
}
