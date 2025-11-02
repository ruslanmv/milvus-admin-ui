import React, { useEffect, useMemo, useRef, useState } from "react";
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
  Tabs,
  Tooltip,
  Checkbox,
  Slider,
  Modal,
  Descriptions,
} from "antd";
import {
  ReloadOutlined,
  ThunderboltOutlined,
  AimOutlined,
  SearchOutlined,
  FileSyncOutlined,
  InfoCircleOutlined,
  CodeOutlined,
  ExperimentOutlined,
  LinkOutlined,
  FileAddOutlined,
  DatabaseOutlined,
} from "@ant-design/icons";
import { useCustom, useCustomMutation } from "@refinedev/core";
import { useNavigate, Link } from "react-router-dom";

type CollectionItem = {
  id: string;
  name: string;
  num_entities?: number;
  fields?: any[];
  indexes?: any[];
};

type Hit = Record<string, any> & { score?: number; doc_id?: string; text?: string };

const { Text, Title, Paragraph } = Typography;

const MODEL_PRESETS = [
  { label: "MiniLM (384d)", value: "sentence-transformers/paraphrase-MiniLM-L6-v2", dim: 384 },
  { label: "all-MiniLM-L6-v2 (384d)", value: "sentence-transformers/all-MiniLM-L6-v2", dim: 384 },
  { label: "bge-small (384d)", value: "BAAI/bge-small-en-v1.5", dim: 384 },
  { label: "e5-small (384d)", value: "intfloat/e5-small-v2", dim: 384 },
];

const RERANKERS = [
  { label: "None", value: "" },
  { label: "bge-reranker-base", value: "BAAI/bge-reranker-base" },
  { label: "cross-encoder/ms-marco-MiniLM-L-6-v2", value: "cross-encoder/ms-marco-MiniLM-L-6-v2" },
];

const RETRIEVAL_TYPES = [
  { label: "Vector", value: "vector" },
  { label: "Hybrid (dense+sparse)", value: "hybrid" },
  { label: "Keyword", value: "keyword" },
];

function deriveDims(rec?: CollectionItem): { dim?: number; metric?: string; indexType?: string } {
  if (!rec) return {};
  const vf = (rec.fields ?? []).find((f: any) => String(f.dtype).includes("FLOAT_VECTOR"));
  const idx0 = (rec.indexes ?? [])[0];
  return { dim: vf?.dim, metric: idx0?.metric_type, indexType: idx0?.index_type };
}

export default function Rag() {
  const navigate = useNavigate();

  // Fetch collections to populate selects
  const { data: collectionsData, refetch: refetchCollections, isLoading: isFetchingCollections } = useCustom({
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
  const [results, setResults] = useState<Hit[]>([]);
  const [lastRequest, setLastRequest] = useState<any>(null);
  const [lastResponse, setLastResponse] = useState<any>(null);

  // Success banners (shown in place of the tip)
  const [showSyncSuccess, setShowSyncSuccess] = useState(false);
  const [showRefreshSuccess, setShowRefreshSuccess] = useState(false);
  const hideSyncRef = useRef<number | null>(null);
  const hideRefreshRef = useRef<number | null>(null);

  // Trace
  const [trace, setTrace] = useState<{ searchMs?: number; params?: any }>({});

  // Filters (simple builder: one row for now; can be extended)
  const [filterKey, setFilterKey] = useState("");
  const [filterOp, setFilterOp] = useState("==");
  const [filterVal, setFilterVal] = useState("");

  // Retrieval settings
  const [retrievalType, setRetrievalType] = useState("vector");
  const [mmr, setMmr] = useState(false);
  const [lambda, setLambda] = useState(0.5);
  const [reranker, setReranker] = useState("");
  const [topR, setTopR] = useState(20);
  const [overrideParam, setOverrideParam] = useState<number | undefined>(undefined); // nprobe / efSearch / search_list

  // Active collection derived
  const activeCollectionName: string | undefined =
    Form.useWatch("collection", searchForm) ||
    (collections.find((x) => x.name === "documents") ? "documents" : collections[0]?.name);

  const activeCollection = collections.find((c) => c.name === activeCollectionName);
  const { dim, metric, indexType } = deriveDims(activeCollection);

  // Active embedder/preset
  const [embedModel, setEmbedModel] = useState(MODEL_PRESETS[0].value);

  // Keyboard run (Cmd/Ctrl + Enter)
  const queryRef = useRef<any>(null);
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      runSearch();
    }
  };

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
    searchForm.setFieldsValue({
      collection: def,
      topk: 5,
      model: embedModel,
      query: "Where is the incident root-cause template?",
    });
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
    // Validate JSON before sending
    let docs: any;
    try {
      docs = JSON.parse(v.docs);
      if (!Array.isArray(docs)) {
        throw new Error("Docs must be a JSON array of objects like { doc_id, text }.");
      }
    } catch (e: any) {
      Modal.error({
        title: "Invalid JSON for Docs",
        content: e?.message || String(e),
      });
      return;
    }
    await callApi({
      url: "/api/rag/insert",
      method: "post",
      values: {
        collection: v.collection,
        docs,
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

  async function runSearch() {
    const v = await searchForm.validateFields();
    const payload = {
      collection: v.collection,
      query: v.query,
      topk: v.topk,
      model: v.model || null,
      // NOTE: server auto-chooses search params based on index.
      // You can extend your backend to accept overrides like { params: { nprobe } }.
    };
    const t0 = performance.now();
    const res = await callApi({
      url: "/api/rag/search",
      method: "post",
      values: payload,
      successNotification: () => ({ message: "Searched", description: "" }),
      errorNotification: (err) => ({
        message: "Search failed",
        description: (err as any)?.response?.data?.detail || String(err),
        type: "error",
      }),
    });
    const t1 = performance.now();

    setLastRequest(payload);
    setLastResponse((res as any)?.data);
    setTrace({
      searchMs: Math.round(t1 - t0),
      params: (res as any)?.data?.search_params ?? {},
    });
    setResults(((res as any)?.data?.hits ?? []) as Hit[]);
  }

  const hasCollections = collections.length > 0;
  const showTip = !showSyncSuccess && !showRefreshSuccess;

  // --- JSON tab: code generation for lastRequest/lastResponse
  const codePython = (req: any) =>
    `import requests, json

payload = ${JSON.stringify(req ?? {}, null, 2)}
r = requests.post("${window.location.origin}/api/rag/search", json=payload)
print(json.dumps(r.json(), indent=2))`;

  const codeJS = (req: any) =>
    `const payload = ${JSON.stringify(req ?? {}, null, 2)};

const res = await fetch("${window.location.origin}/api/rag/search", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
console.log(await res.json());`;

  const escapeSingleQuotes = (s: string) => s.split("'").join("'\\''");
  const codeCurl = (req: any) =>
    `curl -s ${window.location.origin}/api/rag/search \\
  -H 'Content-Type: application/json' \\
  -d '${escapeSingleQuotes(JSON.stringify(req ?? {}, null, 2))}'`;

  // Helpers
  const headerBadge = (label: string, value?: React.ReactNode, color?: string) => (
    <Tag color={color ?? "blue"} style={{ borderRadius: 6 }}>
      <Text strong>{label}:</Text>&nbsp;<span>{value ?? "—"}</span>
    </Tag>
  );

  const [metaOpenHit, setMetaOpenHit] = useState<Hit | null>(null);

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      {/* Enterprise intro (AWS-style) */}
      <Card
        style={{ borderRadius: 12, border: "1px solid rgba(0,0,0,0.06)", marginBottom: 4 }}
        bodyStyle={{ padding: 16 }}
      >
        <Row align="middle" gutter={[12, 12]}>
          <Col flex="none">
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                background: "#ecfeff",
                display: "grid",
                placeItems: "center",
              }}
            >
              <InfoCircleOutlined style={{ color: "#0891b2", fontSize: 18 }} />
            </div>
          </Col>
          <Col flex="auto">
            <Title level={5} style={{ margin: 0 }}>
              RAG (Retrieval-Augmented Generation)
            </Title>
            <Paragraph type="secondary" style={{ margin: 0 }}>
              Run retrieval + generation, debug quality/latency, and export reproducible calls. No heavy admin here.
            </Paragraph>
          </Col>
          <Col flex="none">
            <Space wrap>
              <Button icon={<FileSyncOutlined />} type="primary" onClick={handleSync} loading={isLoading}>
                Sync documents
              </Button>
              <Button icon={<ReloadOutlined />} onClick={handleRefreshCollections} disabled={isLoading}>
                Refresh collections
              </Button>
              <Link to="/collections">
                <Button icon={<DatabaseOutlined />}>Open Collections</Button>
              </Link>
            </Space>
          </Col>
        </Row>
      </Card>

      {/* Banners slot: Tip or success banners (animated) */}
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
            message="What you can do"
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                <li>Search with vector / hybrid / keyword. Tune top-K & index params.</li>
                <li>Preview results with scores, metadata, quick actions, deep links.</li>
                <li>Generate shareable JSON & ready-to-run Python / JS / cURL.</li>
              </ul>
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

      {/* Header: Active collection & model preset */}
      <Card style={{ borderRadius: 12 }} bodyStyle={{ padding: 16 }}>
        <Row gutter={[12, 12]} align="middle">
          <Col flex="auto">
            <Space wrap>
              {headerBadge("Active Collection", activeCollectionName, "geekblue")}
              {headerBadge("Index", indexType)}
              {headerBadge("Metric", metric)}
              {headerBadge("Dim", dim)}
            </Space>
          </Col>
          <Col flex="none">
            <Space>
              <Text type="secondary">Model preset</Text>
              <Select
                value={embedModel}
                options={MODEL_PRESETS}
                style={{ width: 280 }}
                onChange={(v) => {
                  setEmbedModel(v);
                  searchForm.setFieldsValue({ model: v });
                }}
              />
            </Space>
          </Col>
        </Row>
      </Card>

      {/* Tabs */}
      <Tabs
        defaultActiveKey="search"
        items={[
          {
            key: "search",
            label: (
              <Space>
                <SearchOutlined />
                Search
              </Space>
            ),
            children: (
              <Card hoverable>
                <Form
                  form={searchForm}
                  layout="vertical"
                  initialValues={{
                    collection: activeCollectionName || "documents",
                    query: "Where is the incident root-cause template?",
                    topk: 5,
                    model: embedModel,
                  }}
                >
                  <Row gutter={[16, 16]}>
                    <Col xs={24} md={12}>
                      <Form.Item label="Collection" name="collection" rules={[{ required: true }]}>
                        <Select
                          placeholder="Select a collection"
                          options={collections.map((c) => ({ value: c.name, label: c.name }))}
                          showSearch
                          optionFilterProp="label"
                          disabled={!hasCollections || isFetchingCollections}
                        />
                      </Form.Item>

                      <Form.Item label="Query" name="query" rules={[{ required: true }]}>
                        <Input.TextArea
                          rows={4}
                          ref={queryRef}
                          onKeyDown={onKeyDown}
                          placeholder="Type your question… (Cmd/Ctrl + Enter to run)"
                        />
                      </Form.Item>

                      <Space wrap>
                        <Form.Item label="Top-K" name="topk" rules={[{ required: true }]} style={{ marginBottom: 0 }}>
                          <InputNumber min={1} style={{ width: 120 }} />
                        </Form.Item>

                        <Form.Item label="Retrieval" style={{ marginBottom: 0 }}>
                          <Select
                            value={retrievalType}
                            onChange={setRetrievalType}
                            options={RETRIEVAL_TYPES}
                            style={{ width: 220 }}
                          />
                        </Form.Item>

                        <Form.Item label="Model (optional)" name="model" style={{ marginBottom: 0 }}>
                          <Input placeholder={MODEL_PRESETS[0].value} style={{ width: 300 }} />
                        </Form.Item>
                      </Space>

                      <Divider style={{ margin: "16px 0" }} />

                      <Row gutter={[12, 12]}>
                        <Col xs={24} md={12}>
                          <Text strong>Index params</Text>
                          <div style={{ marginTop: 8 }}>
                            {String(indexType || "").toUpperCase().startsWith("IVF") ? (
                              <Space align="center">
                                <Text type="secondary">nprobe</Text>
                                <InputNumber
                                  min={1}
                                  value={overrideParam}
                                  onChange={(v) => setOverrideParam(v == null ? undefined : Number(v))}
                                  placeholder="e.g., 10"
                                  style={{ width: 140 }}
                                />
                                <Tooltip title="Server auto-chooses a sensible nprobe; override requires backend support.">
                                  <InfoCircleOutlined />
                                </Tooltip>
                              </Space>
                            ) : String(indexType || "").toUpperCase() === "HNSW" ? (
                              <Space align="center">
                                <Text type="secondary">efSearch</Text>
                                <InputNumber
                                  min={1}
                                  value={overrideParam}
                                  onChange={(v) => setOverrideParam(v == null ? undefined : Number(v))}
                                  placeholder="e.g., 64"
                                  style={{ width: 140 }}
                                />
                                <Tooltip title="Server auto-chooses a sensible ef; override requires backend support.">
                                  <InfoCircleOutlined />
                                </Tooltip>
                              </Space>
                            ) : String(indexType || "").toUpperCase() === "DISKANN" ? (
                              <Space align="center">
                                <Text type="secondary">search_list</Text>
                                <InputNumber
                                  min={1}
                                  value={overrideParam}
                                  onChange={(v) => setOverrideParam(v == null ? undefined : Number(v))}
                                  placeholder="e.g., 100"
                                  style={{ width: 140 }}
                                />
                                <Tooltip title="Override requires backend support.">
                                  <InfoCircleOutlined />
                                </Tooltip>
                              </Space>
                            ) : (
                              <Text type="secondary">No index param overrides for this index type.</Text>
                            )}
                          </div>
                        </Col>

                        <Col xs={24} md={12}>
                          <Space direction="vertical" style={{ width: "100%" }}>
                            <Space align="center">
                              <Checkbox checked={mmr} onChange={(e) => setMmr(e.target.checked)}>
                                MMR
                              </Checkbox>
                              <Tooltip title="Maximal Marginal Relevance to diversify results.">
                                <InfoCircleOutlined />
                              </Tooltip>
                            </Space>
                            <div style={{ opacity: mmr ? 1 : 0.4 }}>
                              <Text type="secondary">λ</Text>
                              <Slider min={0} max={1} step={0.05} value={lambda} onChange={setLambda} style={{ width: 240 }} />
                            </div>
                          </Space>
                        </Col>
                      </Row>

                      <Divider style={{ margin: "16px 0" }} />

                      <Row gutter={[12, 12]}>
                        <Col xs={24} md={12}>
                          <Text strong>Filters</Text>
                          <Space direction="vertical" style={{ width: "100%", marginTop: 8 }}>
                            <Space wrap>
                              <Input
                                placeholder="metadata.key"
                                value={filterKey}
                                onChange={(e) => setFilterKey(e.target.value)}
                                style={{ width: 180 }}
                              />
                              <Select
                                value={filterOp}
                                onChange={setFilterOp}
                                style={{ width: 120 }}
                                options={[
                                  { value: "==", label: "==" },
                                  { value: "!=", label: "!=" },
                                  { value: ">", label: ">" },
                                  { value: "<", label: "<" },
                                  { value: "in", label: "in" },
                                  { value: "contains", label: "contains" },
                                ]}
                              />
                              <Input
                                placeholder="value"
                                value={filterVal}
                                onChange={(e) => setFilterVal(e.target.value)}
                                style={{ width: 200 }}
                              />
                            </Space>
                            <Text type="secondary">Raw expression (coming soon)</Text>
                            <Input disabled placeholder='example: metadata.lang == "en" AND partition == "guides"' />
                          </Space>
                        </Col>

                        <Col xs={24} md={12}>
                          <Text strong>Reranker (optional)</Text>
                          <Space wrap style={{ marginTop: 8 }}>
                            <Select
                              value={reranker}
                              onChange={setReranker}
                              options={RERANKERS}
                              style={{ width: 300 }}
                            />
                            <InputNumber
                              min={1}
                              value={topR}
                              onChange={(v) => setTopR(Number(v || 1))}
                              addonBefore="top_r"
                              style={{ width: 160 }}
                            />
                          </Space>
                        </Col>
                      </Row>

                      <Divider style={{ margin: "16px 0" }} />

                      <Space wrap>
                        <Button
                          type="primary"
                          icon={<ThunderboltOutlined />}
                          onClick={runSearch}
                          loading={isLoading}
                          disabled={!hasCollections}
                        >
                          Run search
                        </Button>
                        <Button icon={<AimOutlined />} onClick={() => setResults([])}>
                          Clear
                        </Button>
                      </Space>
                    </Col>

                    {/* Results */}
                    <Col xs={24} md={12}>
                      <Title level={5} style={{ marginTop: 0 }}>
                        Results
                      </Title>
                      {results.length === 0 ? (
                        <Text type="secondary">No results yet.</Text>
                      ) : (
                        <List
                          bordered
                          dataSource={results}
                          renderItem={(r: Hit, idx) => (
                            <List.Item key={r.doc_id ?? idx} style={{ transition: "background .2s ease" }}>
                              <Space direction="vertical" style={{ width: "100%" }}>
                                <Row align="middle" justify="space-between">
                                  <Col>
                                    <Text strong>#{idx + 1}</Text>
                                  </Col>
                                  <Col>
                                    <Tag color="green">
                                      {typeof r.score === "number" ? r.score.toFixed(4) : r.score}
                                    </Tag>
                                  </Col>
                                </Row>

                                {r.doc_id && (
                                  <Text type="secondary">
                                    doc_id: <Text code>{r.doc_id}</Text>
                                  </Text>
                                )}

                                {r.text ? (
                                  <Typography.Paragraph ellipsis={{ rows: 4, expandable: true, symbol: "more" }}>
                                    {r.text}
                                  </Typography.Paragraph>
                                ) : (
                                  <Text type="secondary">
                                    (No "text" field; server returns any of: doc_id/title/url/meta/text when present.)
                                  </Text>
                                )}

                                <Space wrap>
                                  <Button size="small" onClick={() => setMetaOpenHit(r)}>
                                    View metadata
                                  </Button>
                                  {r.url && (
                                    <Button size="small" icon={<LinkOutlined />} href={r.url} target="_blank">
                                      Open source
                                    </Button>
                                  )}
                                  <Link to="/collections">
                                    <Button size="small" icon={<DatabaseOutlined />}>
                                      Open in Collections
                                    </Button>
                                  </Link>
                                  <Button size="small" icon={<FileAddOutlined />} disabled>
                                    Re-embed
                                  </Button>
                                </Space>
                              </Space>
                            </List.Item>
                          )}
                        />
                      )}

                      {/* Trace summary */}
                      <Divider />
                      <Title level={5} style={{ marginTop: 0 }}>
                        Trace (summary)
                      </Title>
                      <Space direction="vertical">
                        <Text>
                          <strong>Search</strong> ≈ {trace.searchMs ?? "—"} ms
                        </Text>
                        <Text type="secondary">
                          Params: <code>{JSON.stringify(trace.params ?? {}, null, 0)}</code>
                        </Text>
                        <Text type="secondary">
                          Note: Additional stages (embed/filter/rerank/generate) can be wired to show a full timeline.
                        </Text>
                      </Space>
                    </Col>
                  </Row>
                </Form>
              </Card>
            ),
          },
          {
            key: "answer",
            label: (
              <Space>
                <CodeOutlined />
                Answer
              </Space>
            ),
            children: (
              <Card hoverable>
                <Row gutter={[16, 16]}>
                  <Col xs={24} md={12}>
                    <Title level={5} style={{ marginTop: 0 }}>
                      LLM settings
                    </Title>
                    <Space direction="vertical" style={{ width: "100%" }}>
                      <Select
                        defaultValue="openai:gpt-4o-mini"
                        options={[
                          { label: "OpenAI — gpt-4o-mini", value: "openai:gpt-4o-mini" },
                          { label: "OpenAI — gpt-4.1-mini", value: "openai:gpt-4.1-mini" },
                          { label: "watsonx — granite-13b-chat-v2", value: "watsonx:granite-13b-chat-v2" },
                        ]}
                        style={{ width: 320 }}
                      />
                      <Input.TextArea rows={3} placeholder="System prompt" />
                      <Space wrap>
                        <InputNumber addonBefore="temperature" min={0} max={2} step={0.1} defaultValue={0.2} />
                        <InputNumber addonBefore="max tokens" min={64} step={32} defaultValue={512} />
                      </Space>
                      <Checkbox disabled>Streaming</Checkbox>
                    </Space>
                  </Col>
                  <Col xs={24} md={12}>
                    <Title level={5} style={{ marginTop: 0 }}>
                      Citations & post-processing
                    </Title>
                    <Space direction="vertical" style={{ width: "100%" }}>
                      <Checkbox>Inline citations [1]</Checkbox>
                      <Checkbox>Footnotes with chunk expand</Checkbox>
                      <Checkbox>Deduplicate by URL</Checkbox>
                      <Checkbox>Diversify by source</Checkbox>
                      <Checkbox>Merge adjacent sections</Checkbox>
                      <InputNumber addonBefore="Limit per source" min={1} defaultValue={2} />
                    </Space>
                    <Divider />
                    <Text type="secondary">Cost/tokens will appear after a run.</Text>
                  </Col>
                </Row>
                <Divider />
                <Alert
                  type="info"
                  showIcon
                  message="Coming soon"
                  description="Wire this tab to your LLM endpoint to generate answers from retrieved context."
                />
              </Card>
            ),
          },
          {
            key: "trace",
            label: (
              <Space>
                <ExperimentOutlined />
                Trace
              </Space>
            ),
            children: (
              <Card hoverable>
                <Title level={5} style={{ marginTop: 0 }}>
                  Timeline
                </Title>
                <Paragraph>
                  <strong>Embed</strong> → <strong>Search</strong> → <strong>Filter</strong> →{" "}
                  <strong>Rerank</strong> → <strong>Generate</strong>
                </Paragraph>
                <Alert
                  type="info"
                  showIcon
                  message="This is a lightweight trace."
                  description="Currently shows end-to-end search time and server-selected params. Extend to capture embeddings, filters, rerank and generation latencies."
                />
                <Divider />
                <Descriptions bordered size="small" column={2}>
                  <Descriptions.Item label="Search time (ms)">{trace.searchMs ?? "—"}</Descriptions.Item>
                  <Descriptions.Item label="Milvus params">
                    <code>{JSON.stringify(trace.params ?? {}, null, 0)}</code>
                  </Descriptions.Item>
                  <Descriptions.Item label="Vector field">{lastResponse?.vector_field ?? "—"}</Descriptions.Item>
                  <Descriptions.Item label="Output fields">
                    {(lastResponse?.output_fields ?? []).join(", ") || "—"}
                  </Descriptions.Item>
                </Descriptions>
              </Card>
            ),
          },
          {
            key: "json",
            label: (
              <Space>
                <CodeOutlined />
                JSON
              </Space>
            ),
            children: (
              <Card hoverable>
                <Row gutter={[16, 16]}>
                  <Col xs={24} md={12}>
                    <Title level={5} style={{ marginTop: 0 }}>
                      Request
                    </Title>
                    <pre style={{ background: "#0b1220", color: "#e5e7eb", padding: 12, borderRadius: 8, overflowX: "auto" }}>
                      <code>{JSON.stringify(lastRequest ?? {}, null, 2)}</code>
                    </pre>
                  </Col>
                  <Col xs={24} md={12}>
                    <Title level={5} style={{ marginTop: 0 }}>
                      Response
                    </Title>
                    <pre style={{ background: "#0b1220", color: "#e5e7eb", padding: 12, borderRadius: 8, overflowX: "auto" }}>
                      <code>{JSON.stringify(lastResponse ?? {}, null, 2)}</code>
                    </pre>
                  </Col>
                </Row>
                <Divider />
                <Tabs
                  items={[
                    {
                      key: "py",
                      label: "Python",
                      children: (
                        <pre style={{ background: "#0b1220", color: "#e5e7eb", padding: 12, borderRadius: 8, overflowX: "auto" }}>
                          <code>{codePython(lastRequest)}</code>
                        </pre>
                      ),
                    },
                    {
                      key: "js",
                      label: "JavaScript",
                      children: (
                        <pre style={{ background: "#0b1220", color: "#e5e7eb", padding: 12, borderRadius: 8, overflowX: "auto" }}>
                          <code>{codeJS(lastRequest)}</code>
                        </pre>
                      ),
                    },
                    {
                      key: "curl",
                      label: "cURL",
                      children: (
                        <pre style={{ background: "#0b1220", color: "#e5e7eb", padding: 12, borderRadius: 8, overflowX: "auto" }}>
                          <code>{codeCurl(lastRequest)}</code>
                        </pre>
                      ),
                    },
                  ]}
                />
              </Card>
            ),
          },
          {
            key: "eval",
            label: (
              <Space>
                <ExperimentOutlined />
                Eval
              </Space>
            ),
            children: (
              <Card hoverable>
                <Alert
                  type="info"
                  showIcon
                  message="Quick quality harness"
                  description="Upload JSONL (one per line: { q, positives: [doc_id] }) to compute Recall@k, nDCG@k, MRR, and latency p50/p95. Compare presets side-by-side. (Coming soon)"
                />
              </Card>
            ),
          },
        ]}
      />

      {/* Insert (demo) — keep lightweight and separate from main tabs */}
      <Card
        title="Insert Documents (demo)"
        extra={<Tag color="blue">schema: [doc_id, text, vec]</Tag>}
        hoverable
      >
        <Form
          form={insertForm}
          layout="vertical"
          initialValues={{
            collection: activeCollectionName || "documents",
            docs: JSON.stringify(
              [
                { doc_id: "1", text: "How do I reset my LDAP password?" },
                { doc_id: "2", text: "Postmortem template for production incidents." },
              ],
              null,
              2
            ),
            model: MODEL_PRESETS[0].value,
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
            <Input placeholder={MODEL_PRESETS[0].value} />
          </Form.Item>
          <Space>
            <Button type="primary" onClick={handleInsert} loading={isLoading} disabled={!hasCollections}>
              Insert
            </Button>
            <Button onClick={() => navigate("/collections")}>Go to Collections</Button>
          </Space>
          {!hasCollections && (
            <Paragraph type="secondary" style={{ marginTop: 8 }}>
              No collections available. Use <strong>Sync documents</strong> or create a collection first.
            </Paragraph>
          )}
        </Form>
      </Card>

      {/* View metadata modal */}
      <Modal
        open={!!metaOpenHit}
        onCancel={() => setMetaOpenHit(null)}
        title="Document metadata"
        footer={null}
        width={700}
      >
        <pre style={{ background: "#0b1220", color: "#e5e7eb", padding: 12, borderRadius: 8, overflowX: "auto" }}>
          <code>{JSON.stringify(metaOpenHit ?? {}, null, 2)}</code>
        </pre>
      </Modal>
    </Space>
  );
}
