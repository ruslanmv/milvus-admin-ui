import React, { useMemo, useState } from "react";
import {
  Modal,
  Card,
  Steps,
  Form,
  Input,
  InputNumber,
  Select,
  Button,
  Space,
  Typography,
  Alert,
  Divider,
  Checkbox,
  Row,
  Col,
  Result,
  Tabs,
  Tooltip,
} from "antd";
import {
  DatabaseOutlined,
  CheckCircleTwoTone,
  CloudUploadOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  CloudServerOutlined,
  InfoCircleOutlined,
  ThunderboltOutlined,
  DownloadOutlined,
} from "@ant-design/icons";
import { useCustomMutation } from "@refinedev/core";
import { useNavigate } from "react-router-dom";

const { Title, Text, Paragraph } = Typography;

type WizardMode = "modal" | "page";

type Props = {
  /** If using as a modal inside the List page */
  open?: boolean;
  onClose?: () => void;
  /** Called after a successful creation (and optional ingest) */
  onCreated?: (collectionName: string) => void;
  /** Render as a full page (CollectionsCreate route) */
  standalone?: boolean;
};

const MODEL_PRESETS = [
  { label: "MiniLM (384d)", value: "sentence-transformers/paraphrase-MiniLM-L6-v2", dim: 384 },
  { label: "all-MiniLM-L6-v2 (384d)", value: "sentence-transformers/all-MiniLM-L6-v2", dim: 384 },
  { label: "bge-small (384d)", value: "BAAI/bge-small-en-v1.5", dim: 384 },
  { label: "e5-small (384d)", value: "intfloat/e5-small-v2", dim: 384 },
];

type SourceType = "local" | "http" | "s3" | "ibm";

const SOURCE_OPTIONS = [
  { label: "Local folder", value: "local", icon: <FolderOpenOutlined /> },
  { label: "HTTP URLs", value: "http", icon: <GlobalOutlined /> },
  { label: "Amazon S3", value: "s3", icon: <CloudUploadOutlined /> },
  { label: "IBM Cloud Object Storage", value: "ibm", icon: <CloudServerOutlined /> },
];

export default function CreateCollectionWizard({
  open,
  onClose,
  onCreated,
  standalone,
}: Props) {
  const navigate = useNavigate();
  const { mutateAsync, isLoading } = useCustomMutation();

  const [current, setCurrent] = useState(0);

  // ---- Step forms
  const [schemaForm] = Form.useForm();
  const [sourceForm] = Form.useForm();
  const [ingestForm] = Form.useForm();

  const metric = Form.useWatch("metric", schemaForm) || "IP";
  const indexType = Form.useWatch("index_type", schemaForm) || "IVF_FLAT";
  const selectedModel = Form.useWatch("model", ingestForm) || MODEL_PRESETS[0].value;
  const sourceType: SourceType = Form.useWatch("source_type", sourceForm) || "local";

  // Default values
  const initialSchema = useMemo(
    () => ({
      name: "documents",
      dim: 384,
      metric: "IP",
      index_type: "IVF_FLAT",
      nlist: 1024,
    }),
    [],
  );

  const initialSource = useMemo(
    () => ({
      source_type: "local" as SourceType,
      local_path: "./data",
      urls: "https://example.com/docs/guide.html\nhttps://example.com/faq.html",
      s3: {
        bucket: "",
        prefix: "",
        region: "",
        endpoint: "",
        access_key_id: "",
        secret_access_key: "",
      },
      ibm: {
        bucket: "",
        prefix: "",
        region: "",
        endpoint: "",
        access_key_id: "",
        secret_access_key: "",
      },
    }),
    [],
  );

  const initialIngest = useMemo(
    () => ({
      model: MODEL_PRESETS[0].value,
      normalize: true,
      chunk_size: 512,
      overlap: 64,
      ocr: false,
      language_detect: true,
      dedupe: true,
    }),
    [],
  );

  const [createdName, setCreatedName] = useState<string>("");
  const [syncTriggered, setSyncTriggered] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleNext = async () => {
    if (current === 0) {
      await schemaForm.validateFields();
    } else if (current === 1) {
      await sourceForm.validateFields();
    } else if (current === 2) {
      await ingestForm.validateFields();
    }
    setCurrent((c) => c + 1);
  };

  const handlePrev = () => setCurrent((c) => Math.max(0, c - 1));

  // Build a config users can save when using non-local sources
  const buildConfig = () => {
    const schema = schemaForm.getFieldsValue();
    const source = sourceForm.getFieldsValue();
    const ingest = ingestForm.getFieldsValue();
    const cfg: any = {
      collection: {
        name: schema.name,
        dim: schema.dim,
        metric: schema.metric,
        index_type: schema.index_type,
        nlist: schema.index_type?.startsWith("IVF") ? schema.nlist : undefined,
      },
      source: { type: source.source_type },
      ingest: {
        model: ingest.model,
        normalize: !!ingest.normalize,
        chunk_size: ingest.chunk_size,
        overlap: ingest.overlap,
        ocr: !!ingest.ocr,
        language_detect: !!ingest.language_detect,
        dedupe: !!ingest.dedupe,
      },
    };
    if (source.source_type === "local") {
      cfg.source.path = source.local_path;
    } else if (source.source_type === "http") {
      cfg.source.urls = (source.urls || "")
        .split("\n")
        .map((s: string) => s.trim())
        .filter(Boolean);
    } else if (source.source_type === "s3") {
      cfg.source = { type: "s3", ...source.s3 };
    } else if (source.source_type === "ibm") {
      cfg.source = { type: "ibm", ...source.ibm };
    }
    return cfg;
  };

  const downloadConfig = () => {
    const cfg = buildConfig();
    const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `milvus-ingest.${cfg.collection?.name || "collection"}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const createCollection = async () => {
    const schema = await schemaForm.validateFields();

    // 1) Create collection
    const createRes = await mutateAsync({
      url: "/api/collections",
      method: "post",
      values: {
        name: schema.name,
        dim: schema.dim,
        metric: schema.metric,
        index_type: schema.index_type,
        nlist: schema.index_type?.startsWith("IVF") ? schema.nlist : 1024,
      },
      successNotification: () => ({ message: "Collection created", description: "" }),
      errorNotification: (err) => ({
        message: "Create failed",
        description: (err as any)?.response?.data?.detail || String(err),
        type: "error",
      }),
    });

    setCreatedName(schema.name);

    // 2) Ingest (if local → trigger /api/sync)
    const source = sourceForm.getFieldsValue();
    if (source.source_type === "local") {
      try {
        await mutateAsync({
          url: "/api/sync",
          method: "post",
          successNotification: () => ({ message: "Ingest started", description: "Sync completed successfully." }),
          errorNotification: (err) => ({
            message: "Sync failed",
            description: (err as any)?.response?.data?.detail || String(err),
            type: "error",
          }),
        });
        setSyncTriggered(true);
      } catch {
        // handled by notification
      }
    }

    setSuccess(true);
    onCreated?.(schema.name);
  };

  const onFinish = async () => {
    await createCollection();
  };

  const stepItems = [
    {
      title: "Schema",
      icon: <DatabaseOutlined />,
    },
    {
      title: "Data source",
      icon: <CloudUploadOutlined />,
    },
    {
      title: "Ingest options",
      icon: <ThunderboltOutlined />,
    },
    {
      title: "Review",
      icon: <CheckCircleTwoTone twoToneColor="#52c41a" />,
    },
  ];

  const content = (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card style={{ borderRadius: 12 }}>
        <Steps
          current={current}
          items={stepItems}
          responsive
          style={{ maxWidth: 920, margin: "0 auto" }}
        />
      </Card>

      {/* STEP 0: Schema */}
      {current === 0 && (
        <Card style={{ borderRadius: 12 }}>
          <Row gutter={[16, 16]}>
            <Col xs={24} md={12}>
              <Title level={5} style={{ marginTop: 0 }}>
                Collection schema
              </Title>
              <Form form={schemaForm} layout="vertical" initialValues={initialSchema}>
                <Form.Item label="Name" name="name" rules={[{ required: true }]}>
                  <Input placeholder="documents" />
                </Form.Item>
                <Form.Item
                  label={
                    <Space>
                      Dim
                      <Tooltip title="Embedding dimension; must match your embedding model output.">
                        <InfoCircleOutlined />
                      </Tooltip>
                    </Space>
                  }
                  name="dim"
                  rules={[{ required: true }]}
                >
                  <InputNumber min={1} style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item label="Metric" name="metric" initialValue="IP">
                  <Select options={[{ value: "IP" }, { value: "L2" }, { value: "COSINE" }]} />
                </Form.Item>
                <Form.Item label="Index Type" name="index_type" initialValue="IVF_FLAT">
                  <Select
                    options={[
                      { value: "IVF_FLAT" },
                      { value: "IVF_SQ8" },
                      { value: "HNSW" },
                      { value: "AUTOINDEX" },
                    ]}
                  />
                </Form.Item>
                {String(indexType).startsWith("IVF") && (
                  <Form.Item
                    label={
                      <Space>
                        nlist
                        <Tooltip title="Number of inverted lists. Larger nlist improves recall at the cost of memory and index build time.">
                          <InfoCircleOutlined />
                        </Tooltip>
                      </Space>
                    }
                    name="nlist"
                    initialValue={1024}
                  >
                    <InputNumber min={2} style={{ width: "100%" }} />
                  </Form.Item>
                )}
              </Form>
            </Col>
            <Col xs={24} md={12}>
              <Alert
                type="info"
                showIcon
                message="Hints"
                description={
                  <div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      <li>
                        Match <strong>dim</strong> to your embedding model (e.g., MiniLM: 384d).
                      </li>
                      <li>
                        <strong>IP</strong> or <strong>COSINE</strong> are common for sentence embeddings;{" "}
                        <strong>L2</strong> for some image models.
                      </li>
                      <li>
                        IVF needs <strong>nlist</strong>; HNSW uses <em>efConstruction</em>/<em>M</em> (server chooses
                        sensible defaults for search).
                      </li>
                    </ul>
                  </div>
                }
              />
              <Divider />
              <Paragraph type="secondary">
                Backend creates schema: <code>[doc_id (PK), text (VARCHAR), vec (FLOAT_VECTOR)]</code>.
              </Paragraph>
            </Col>
          </Row>
          <Divider />
          <Space>
            <Button onClick={onClose} disabled={isLoading}>
              Cancel
            </Button>
            <Button type="primary" onClick={handleNext}>
              Next
            </Button>
          </Space>
        </Card>
      )}

      {/* STEP 1: Data source */}
      {current === 1 && (
        <Card style={{ borderRadius: 12 }}>
          <Row gutter={[16, 16]}>
            <Col xs={24} md={10}>
              <Title level={5} style={{ marginTop: 0 }}>
                Choose data source
              </Title>
              <Form
                form={sourceForm}
                layout="vertical"
                initialValues={initialSource}
                requiredMark="optional"
              >
                <Form.Item label="Source type" name="source_type" rules={[{ required: true }]}>
                  <Select
                    options={SOURCE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                  />
                </Form.Item>

                {/* Local */}
                {sourceType === "local" && (
                  <>
                    <Form.Item
                      label="Local path (relative to server)"
                      name="local_path"
                      rules={[{ required: true }]}
                    >
                      <Input placeholder="./data" />
                    </Form.Item>
                    <Alert
                      type="success"
                      showIcon
                      message="Local ingest"
                      description={
                        <>
                          The server’s <code>/api/sync</code> will ingest from <code>DATA_SOURCE_ROOT</code> (set in
                          <code>.env</code>). After creation, the wizard will trigger a sync automatically.
                        </>
                      }
                    />
                  </>
                )}

                {/* HTTP */}
                {sourceType === "http" && (
                  <>
                    <Form.Item
                      label="URLs (one per line)"
                      name="urls"
                      rules={[{ required: true }]}
                    >
                      <Input.TextArea rows={6} placeholder="https://example.com/docs/guide.html&#10;https://example.com/faq.html" />
                    </Form.Item>
                    <Alert
                      type="info"
                      showIcon
                      message="Download via CLI"
                      description="We’ll generate a config you can save locally and run your ingestion CLI with."
                    />
                  </>
                )}

                {/* S3 */}
                {sourceType === "s3" && (
                  <>
                    <Form.Item label="Bucket" name={["s3", "bucket"]} rules={[{ required: true }]}>
                      <Input />
                    </Form.Item>
                    <Form.Item label="Prefix (optional)" name={["s3", "prefix"]}>
                      <Input placeholder="docs/" />
                    </Form.Item>
                    <Form.Item label="Region" name={["s3", "region"]} rules={[{ required: true }]}>
                      <Input />
                    </Form.Item>
                    <Form.Item label="Endpoint (optional)" name={["s3", "endpoint"]}>
                      <Input placeholder="https://s3.amazonaws.com" />
                    </Form.Item>
                    <Form.Item label="Access Key ID" name={["s3", "access_key_id"]} rules={[{ required: true }]}>
                      <Input.Password />
                    </Form.Item>
                    <Form.Item label="Secret Access Key" name={["s3", "secret_access_key"]} rules={[{ required: true }]}>
                      <Input.Password />
                    </Form.Item>
                    <Alert
                      type="info"
                      showIcon
                      message="We’ll generate a config"
                      description="Download a JSON config and run your ingestion pipeline with it."
                    />
                  </>
                )}

                {/* IBM COS */}
                {sourceType === "ibm" && (
                  <>
                    <Form.Item label="Bucket" name={["ibm", "bucket"]} rules={[{ required: true }]}>
                      <Input />
                    </Form.Item>
                    <Form.Item label="Prefix (optional)" name={["ibm", "prefix"]}>
                      <Input placeholder="docs/" />
                    </Form.Item>
                    <Form.Item label="Region" name={["ibm", "region"]} rules={[{ required: true }]}>
                      <Input placeholder="eu-de" />
                    </Form.Item>
                    <Form.Item label="Endpoint" name={["ibm", "endpoint"]} rules={[{ required: true }]}>
                      <Input placeholder="https://s3.eu-de.cloud-object-storage.appdomain.cloud" />
                    </Form.Item>
                    <Form.Item label="Access Key ID" name={["ibm", "access_key_id"]} rules={[{ required: true }]}>
                      <Input.Password />
                    </Form.Item>
                    <Form.Item label="Secret Access Key" name={["ibm", "secret_access_key"]} rules={[{ required: true }]}>
                      <Input.Password />
                    </Form.Item>
                    <Alert
                      type="info"
                      showIcon
                      message="We’ll generate a config"
                      description="Download a JSON config and run your ingestion pipeline with it."
                    />
                  </>
                )}
              </Form>
            </Col>
            <Col xs={24} md={14}>
              <Alert
                type="warning"
                showIcon
                message="Security tip"
                description="Credentials are only used to generate a local config for your ingestion tooling. They are not sent to the server unless your pipeline expects it."
              />
              <Divider />
              <Paragraph type="secondary">
                Supported file types typically include PDF, DOCX, PPTX, TXT/MD, HTML, CSV/JSONL. Enable OCR for scanned
                PDFs in the next step.
              </Paragraph>
            </Col>
          </Row>
          <Divider />
          <Space>
            <Button onClick={handlePrev}>Back</Button>
            <Button type="primary" onClick={handleNext}>
              Next
            </Button>
          </Space>
        </Card>
      )}

      {/* STEP 2: Ingest options */}
      {current === 2 && (
        <Card style={{ borderRadius: 12 }}>
          <Row gutter={[16, 16]}>
            <Col xs={24} md={12}>
              <Title level={5} style={{ marginTop: 0 }}>
                Embeddings & chunking
              </Title>
              <Form form={ingestForm} layout="vertical" initialValues={initialIngest}>
                <Form.Item
                  label={
                    <Space>
                      Embedding model
                      <Tooltip title="Pick an embedding model. The dimension must match your collection schema.">
                        <InfoCircleOutlined />
                      </Tooltip>
                    </Space>
                  }
                  name="model"
                >
                  <Select options={MODEL_PRESETS} />
                </Form.Item>
                <Form.Item name="normalize" valuePropName="checked">
                  <Checkbox>Normalize embeddings</Checkbox>
                </Form.Item>
                <Form.Item label="Chunk size (tokens/chars)" name="chunk_size" rules={[{ required: true }]}>
                  <InputNumber min={64} step={32} style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item label="Overlap" name="overlap" rules={[{ required: true }]}>
                  <InputNumber min={0} step={8} style={{ width: "100%" }} />
                </Form.Item>
              </Form>
            </Col>
            <Col xs={24} md={12}>
              <Title level={5} style={{ marginTop: 0 }}>
                Preprocessing
              </Title>
              <Form form={ingestForm} layout="vertical">
                <Form.Item name="ocr" valuePropName="checked">
                  <Checkbox>OCR scanned PDFs</Checkbox>
                </Form.Item>
                <Form.Item name="language_detect" valuePropName="checked">
                  <Checkbox>Language detection</Checkbox>
                </Form.Item>
                <Form.Item name="dedupe" valuePropName="checked">
                  <Checkbox>Deduplicate near-identical chunks</Checkbox>
                </Form.Item>
              </Form>
              <Divider />
              <Alert
                type="info"
                showIcon
                message="Heads-up"
                description="These options are saved into a config for your ingestion jobs. The built-in /api/sync uses the server’s defaults."
              />
            </Col>
          </Row>
          <Divider />
          <Space>
            <Button onClick={handlePrev}>Back</Button>
            <Button type="primary" onClick={handleNext}>
              Next
            </Button>
          </Space>
        </Card>
      )}

      {/* STEP 3: Review */}
      {current === 3 && !success && (
        <Card style={{ borderRadius: 12 }}>
          <Title level={5} style={{ marginTop: 0 }}>
            Review & create
          </Title>
          <Tabs
            items={[
              {
                key: "summary",
                label: "Summary",
                children: (
                  <Space direction="vertical" style={{ width: "100%" }}>
                    <Alert
                      type="success"
                      showIcon
                      message="Ready to create"
                      description="We’ll create the collection now. If the source is Local, we will trigger an ingest using /api/sync."
                    />
                    <Divider />
                    <pre
                      style={{
                        background: "#0b1220",
                        color: "#e5e7eb",
                        padding: 12,
                        borderRadius: 8,
                        overflowX: "auto",
                      }}
                    >
                      <code>{JSON.stringify(buildConfig(), null, 2)}</code>
                    </pre>
                  </Space>
                ),
              },
              {
                key: "cli",
                label: "CLI how-to",
                children: (
                  <>
                    <Paragraph>
                      For <Text code>http/s3/ibm</Text> sources, download the config and run your ingest locally:
                    </Paragraph>
                    <pre
                      style={{
                        background: "#0b1220",
                        color: "#e5e7eb",
                        padding: 12,
                        borderRadius: 8,
                        overflowX: "auto",
                      }}
                    >
{`# Save config
mui-ingest --config ./milvus-ingest.<name>.json
# Then (re)build vector DB
mui-create-vectordb
`}
                    </pre>
                  </>
                ),
              },
            ]}
          />
          <Divider />
          <Space>
            <Button onClick={handlePrev}>Back</Button>
            {["http", "s3", "ibm"].includes(sourceType) && (
              <Button icon={<DownloadOutlined />} onClick={downloadConfig}>
                Download config
              </Button>
            )}
            <Button
              type="primary"
              onClick={onFinish}
              loading={isLoading}
              icon={<DatabaseOutlined />}
            >
              Create{sourceType === "local" ? " & Ingest" : ""}
            </Button>
          </Space>
        </Card>
      )}

      {/* Success result */}
      {success && (
        <Result
          status="success"
          title="Collection created"
          subTitle={
            <>
              <div>
                <strong>{createdName}</strong> was created successfully.
              </div>
              {syncTriggered ? (
                <div>Local ingest via <code>/api/sync</code> was triggered.</div>
              ) : (
                <div>
                  Download the config and run your ingestion pipeline if you selected HTTP/S3/IBM.
                </div>
              )}
            </>
          }
          extra={
            <Space>
              {["http", "s3", "ibm"].includes(sourceType) && (
                <Button icon={<DownloadOutlined />} onClick={downloadConfig}>
                  Download config
                </Button>
              )}
              <Button type="primary" onClick={() => navigate("/rag", { state: { collection: createdName } })}>
                Open in RAG
              </Button>
              <Button onClick={() => navigate("/collections")}>Back to Collections</Button>
              {!standalone && (
                <Button onClick={onClose}>Close</Button>
              )}
            </Space>
          }
        />
      )}
    </Space>
  );

  if (standalone) {
    return (
      <div style={{ maxWidth: 1000, margin: "0 auto" }}>
        {content}
      </div>
    );
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={1000}
      destroyOnClose
      styles={{ body: { padding: 0 } }}
    >
      <div style={{ padding: 16 }}>{content}</div>
    </Modal>
  );
}
