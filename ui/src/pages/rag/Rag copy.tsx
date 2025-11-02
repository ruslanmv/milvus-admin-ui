import {
  Card,
  Form,
  Input,
  InputNumber,
  Button,
  Typography,
  Select,
  Space,
  Divider,
  Alert,
  List,
  Tag,
  Row,
  Col,
} from "antd";
import { useCustom, useCustomMutation } from "@refinedev/core";
import React, { useEffect, useMemo, useState, useRef } from "react";

type CollectionItem = {
  id: string;
  name: string;
  num_entities?: number;
  fields?: any[];
  indexes?: any[];
};

export default function Rag() {
  // Fetch collections to populate selects
  const { data: collectionsData, refetch: refetchCollections } = useCustom({
    url: "/api/collections",
    method: "get",
  });
  const collections: CollectionItem[] = useMemo(
    () => (collectionsData?.data?.collections ?? []).map((c: any) => ({ id: c.name, ...c })),
    [collectionsData],
  );

  const [insertForm] = Form.useForm();
  const [searchForm] = Form.useForm();
  const { mutateAsync: callApi, isLoading } = useCustomMutation();
  const [results, setResults] = useState<any[]>([]);

  // Success banners (shown in place of the tip)
  const [showSyncSuccess, setShowSyncSuccess] = useState(false);
  const [showRefreshSuccess, setShowRefreshSuccess] = useState(false);
  const hideSyncRef = useRef<number | null>(null);
  const hideRefreshRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (hideSyncRef.current) window.clearTimeout(hideSyncRef.current);
      if (hideRefreshRef.current) window.clearTimeout(hideRefreshRef.current);
    };
  }, []);

  // Choose a sensible default collection (prefer "documents")
  useEffect(() => {
    const names = collections.map((c) => c.name);
    const def = names.includes("documents") ? "documents" : names[0] || "mui_demo";
    insertForm.setFieldsValue({ collection: def });
    searchForm.setFieldsValue({ collection: def });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collections.length]);

  const handleSync = async () => {
    try {
      await callApi({
        url: "/api/sync",
        method: "post",
        // No successNotification: we show the green success box instead
        errorNotification: (err) => ({
          message: "Sync failed",
          description: (err as any)?.response?.data?.detail || String(err),
          type: "error",
        }),
      });
      setShowRefreshSuccess(false);
      setShowSyncSuccess(true);
      if (hideSyncRef.current) window.clearTimeout(hideSyncRef.current);
      hideSyncRef.current = window.setTimeout(() => setShowSyncSuccess(false), 6000);
      await refetchCollections();
    } catch {
      /* handled by errorNotification */
    }
  };

  const handleRefreshCollections = async () => {
    try {
      await refetchCollections();
      setShowSyncSuccess(false);
      setShowRefreshSuccess(true);
      if (hideRefreshRef.current) window.clearTimeout(hideRefreshRef.current);
      hideRefreshRef.current = window.setTimeout(() => setShowRefreshSuccess(false), 4000);
    } catch {
      /* network errors will reflect in downstream UI if any */
    }
  };

  const handleInsert = async () => {
    const v = await insertForm.validateFields();
    await callApi({
      url: "/api/rag/insert",
      method: "post",
      values: {
        collection: v.collection,
        docs: JSON.parse(v.docs),
        model: v.model || null,
      },
      successNotification: () => ({ message: "Inserted", description: "" }),
      errorNotification: (err) => ({
        message: "Insert failed",
        description: (err as any)?.response?.data?.detail || String(err),
        type: "error",
      }),
    });
    await refetchCollections();
  };

  const handleSearch = async () => {
    const v = await searchForm.validateFields();
    const res = await callApi({
      url: "/api/rag/search",
      method: "post",
      values: {
        collection: v.collection,
        query: v.query,
        topk: v.topk,
        model: v.model || null,
      },
      successNotification: () => ({ message: "Searched", description: "" }),
      errorNotification: (err) => ({
        message: "Search failed",
        description: (err as any)?.response?.data?.detail || String(err),
        type: "error",
      }),
    });
    setResults((res as any)?.data?.hits ?? []);
  };

  const hasCollections = collections.length > 0;
  const showTip = !showSyncSuccess && !showRefreshSuccess;

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      {/* Top area: either Info Tip (with actions) or a green success box — same slot, animated */}
      <div
        style={{
          opacity: showTip ? 1 : 0,
          transform: showTip ? "translateY(0)" : "translateY(-6px)",
          transition: "opacity .3s ease, transform .3s ease",
        }}
      >
        {showTip && (
          <Alert
            type="info"
            showIcon
            message="Tip"
            description="Use Sync to ingest files from ./data and rebuild Milvus collections. Then run Semantic Search against your chosen collection."
            action={
              <Space wrap>
                <Button type="primary" onClick={handleSync} loading={isLoading}>
                  Sync documents
                </Button>
                <Button onClick={handleRefreshCollections} disabled={isLoading}>
                  Refresh collections
                </Button>
              </Space>
            }
            style={{ borderRadius: 10 }}
          />
        )}
      </div>

      <div
        style={{
          opacity: showSyncSuccess ? 1 : 0,
          transform: showSyncSuccess ? "translateY(0)" : "translateY(-6px)",
          transition: "opacity .3s ease, transform .3s ease",
          marginTop: showSyncSuccess ? 0 : -8,
        }}
      >
        {showSyncSuccess && (
          <Alert
            type="success"
            showIcon
            closable
            onClose={() => setShowSyncSuccess(false)}
            message={<strong>Sync complete</strong>}
            description="Documents ingested and Milvus collections updated."
            style={{ borderRadius: 10, boxShadow: "0 8px 24px rgba(16,185,129,0.18)" }}
          />
        )}
      </div>

      <div
        style={{
          opacity: showRefreshSuccess ? 1 : 0,
          transform: showRefreshSuccess ? "translateY(0)" : "translateY(-6px)",
          transition: "opacity .3s ease, transform .3s ease",
          marginTop: showRefreshSuccess ? 0 : -8,
        }}
      >
        {showRefreshSuccess && (
          <Alert
            type="success"
            showIcon
            closable
            onClose={() => setShowRefreshSuccess(false)}
            message={<strong>Collections refreshed</strong>}
            description="Latest collection list and entity counts loaded."
            style={{ borderRadius: 10, boxShadow: "0 8px 24px rgba(16,185,129,0.18)" }}
          />
        )}
      </div>

      {/* Insert Card */}
      <Card
        title="Insert Documents"
        extra={<Tag color="blue">demo schema: [doc_id, text, vec]</Tag>}
        hoverable
      >
        <Form
          form={insertForm}
          layout="vertical"
          initialValues={{
            collection: "documents",
            docs: JSON.stringify(
              [
                { doc_id: "1", text: "How do I reset my LDAP password?" },
                { doc_id: "2", text: "Postmortem template for production incidents." },
              ],
              null,
              2
            ),
            model: "sentence-transformers/paraphrase-MiniLM-L6-v2",
          }}
        >
          <Form.Item label="Collection" name="collection" rules={[{ required: true }]}>
            <Select
              placeholder="Select a collection"
              options={collections.map((c) => ({ value: c.name, label: c.name }))}
              showSearch
              optionFilterProp="label"
              disabled={!hasCollections}
            />
          </Form.Item>
          <Form.Item
            label="Docs (JSON array of {doc_id, text})"
            name="docs"
            rules={[{ required: true }]}
          >
            <Input.TextArea rows={6} spellCheck={false} />
          </Form.Item>
          <Form.Item label="Model (optional)" name="model">
            <Input placeholder="sentence-transformers/paraphrase-MiniLM-L6-v2" />
          </Form.Item>
          <Button type="primary" onClick={handleInsert} loading={isLoading} disabled={!hasCollections}>
            Insert
          </Button>
          {!hasCollections && (
            <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
              No collections available. Use <strong>Sync documents</strong> or create a collection first.
            </Typography.Paragraph>
          )}
        </Form>
      </Card>

      {/* Search Card */}
      <Card title="Semantic Search" hoverable>
        <Form
          form={searchForm}
          layout="vertical"
          initialValues={{
            collection: "documents",
            query: "Where is the incident root-cause template?",
            topk: 3,
            model: "",
          }}
        >
          <Form.Item label="Collection" name="collection" rules={[{ required: true }]}>
            <Select
              placeholder="Select a collection"
              options={collections.map((c) => ({ value: c.name, label: c.name }))}
              showSearch
              optionFilterProp="label"
              disabled={!hasCollections}
            />
          </Form.Item>
          <Form.Item label="Query" name="query" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="TopK" name="topk" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: 140 }} />
          </Form.Item>
          <Form.Item label="Model (optional)" name="model">
            <Input />
          </Form.Item>
          <Space>
            <Button type="primary" onClick={handleSearch} loading={isLoading} disabled={!hasCollections}>
              Search
            </Button>
            <Button onClick={() => setResults([])}>Clear</Button>
          </Space>
        </Form>

        <Divider />

        <Typography.Title level={5} style={{ marginTop: 0 }}>
          Results
        </Typography.Title>
        {results.length === 0 ? (
          <Typography.Text type="secondary">No results yet.</Typography.Text>
        ) : (
          <List
            bordered
            dataSource={results}
            renderItem={(r: any, idx) => (
              <List.Item style={{ transition: "background .2s ease" }}>
                <Space direction="vertical" style={{ width: "100%" }}>
                  <Row align="middle" justify="space-between">
                    <Col>
                      <Typography.Text strong>#{idx + 1}</Typography.Text>
                    </Col>
                    <Col>
                      <Tag color="green">{typeof r.score === "number" ? r.score.toFixed(4) : r.score}</Tag>
                    </Col>
                  </Row>

                  {r.doc_id && (
                    <Typography.Text type="secondary">
                      doc_id: <Typography.Text code>{r.doc_id}</Typography.Text>
                    </Typography.Text>
                  )}

                  {r.text ? (
                    <Typography.Paragraph ellipsis={{ rows: 4, expandable: true, symbol: "more" }}>
                      {r.text}
                    </Typography.Paragraph>
                  ) : (
                    <Typography.Text type="secondary">
                      (No "text" field returned; server returns any of: doc_id/title/url/meta/text when present.)
                    </Typography.Text>
                  )}
                </Space>
              </List.Item>
            )}
          />
        )}
      </Card>
    </Space>
  );
}
