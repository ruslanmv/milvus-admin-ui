// ui/src/pages/collections/components/CreateCollectionWizard.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
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
  Upload,
  Progress,
  message,
  Spin,
} from "antd";
import type { UploadFile, UploadProps } from "antd/es/upload/interface";
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
  InboxOutlined,
} from "@ant-design/icons";
import { useNavigate } from "react-router-dom";

const { Title, Text, Paragraph } = Typography;

type Props = {
  open?: boolean;
  onClose?: () => void;
  onCreated?: (collectionName: string) => void;
  standalone?: boolean;
};

type SourceType = "upload" | "local" | "http" | "s3" | "ibm";
type ModelOption = { label: string; value: string; dim: number };

const FALLBACK_MODELS: ModelOption[] = [
  { label: "MiniLM (384d)", value: "sentence-transformers/paraphrase-MiniLM-L6-v2", dim: 384 },
  { label: "all-MiniLM-L6-v2 (384d)", value: "sentence-transformers/all-MiniLM-L6-v2", dim: 384 },
  { label: "bge-small-en-v1.5 (384d)", value: "BAAI/bge-small-en-v1.5", dim: 384 },
  { label: "e5-small-v2 (384d)", value: "intfloat/e5-small-v2", dim: 384 },
];

const SOURCE_OPTIONS = [
  { label: "Upload from browser", value: "upload", icon: <CloudUploadOutlined /> },
  { label: "Local folder (server)", value: "local", icon: <FolderOpenOutlined /> },
  { label: "HTTP URLs", value: "http", icon: <GlobalOutlined /> },
  { label: "Amazon S3", value: "s3", icon: <CloudUploadOutlined /> },
  { label: "IBM Cloud Object Storage", value: "ibm", icon: <CloudServerOutlined /> },
];

const ACCEPTED_EXT =
  ".pdf,.doc,.docx,.ppt,.pptx,.txt,.md,.rtf,.html,.htm,.mdx,.csv,.json,.jsonl,.epub,.xls,.xlsx";

export default function CreateCollectionWizard({
  open,
  onClose,
  onCreated,
  standalone,
}: Props) {
  const navigate = useNavigate();

  const [current, setCurrent] = useState(0);

  // Step forms
  const [schemaForm] = Form.useForm();
  const [sourceForm] = Form.useForm();
  const [ingestForm] = Form.useForm();

  const indexType = Form.useWatch("index_type", schemaForm) || "IVF_FLAT";
  const sourceType: SourceType = Form.useWatch("source_type", sourceForm) || "upload";

  // Model catalog (from backend)
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(FALLBACK_MODELS);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/rag/models");
        const data = await res.json();
        if (Array.isArray(data?.models) && data.models.length > 0) {
          const opts: ModelOption[] = data.models.map((m: any) => ({
            label: `${m.label || m.id} (${m.dim}d)`,
            value: m.id,
            dim: m.dim,
          }));
          setModelOptions(opts);
          const cur = ingestForm.getFieldValue("model");
          if (!cur) {
            ingestForm.setFieldsValue({ model: opts[0].value });
            schemaForm.setFieldsValue({ dim: opts[0].dim });
          }
        }
      } catch {
        /* fallback options already set */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Upload state
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [selectFolder, setSelectFolder] = useState<boolean>(false);
  const [uploadPct, setUploadPct] = useState<number>(0);
  const [uploading, setUploading] = useState<boolean>(false);

  // Processing job state
  const [processingJobId, setProcessingJobId] = useState<string | null>(null);
  const [job, setJob] = useState<any>(null);
  const pollRef = useRef<number | null>(null);

  // Success screen
  const [createdName, setCreatedName] = useState<string>("");
  const [syncTriggered, setSyncTriggered] = useState(false);
  const [success, setSuccess] = useState(false);

  // Notifications control
  const doneNotifiedRef = useRef(false);
  useEffect(() => {
    doneNotifiedRef.current = false;
  }, [processingJobId]);

  // Fake progress for smooth UX (like AddDataWizard)
  const [fakePct, setFakePct] = useState(0);
  useEffect(() => {
    if (!processingJobId) {
      setFakePct(0);
      return;
    }
    if (job?.status === "done" || job?.status === "error") {
      setFakePct(100);
      return;
    }
    const t = window.setInterval(() => {
      setFakePct((p) => (p < 95 ? Math.min(95, p + 2 + Math.random() * 3) : p));
    }, 500);
    return () => window.clearInterval(t);
  }, [processingJobId, job?.status]);

  // Poll job progress when we have a job id
  useEffect(() => {
    if (!processingJobId) return;
    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/${processingJobId}`);
        const j = await res.json();
        setJob(j.job);
        if (["done", "error"].includes(j.job?.status)) {
          if (pollRef.current) window.clearInterval(pollRef.current);
          pollRef.current = null;
          if (j.job.status === "done") {
            if (!doneNotifiedRef.current) {
              doneNotifiedRef.current = true;
              message.success("Ingest completed.");
              setSuccess(true);
            }
          } else {
            if (!doneNotifiedRef.current) {
              doneNotifiedRef.current = true;
              message.error("Ingest failed. See logs below.");
            }
          }
        }
      } catch {
        /* ignore transient */
      }
    };
    tick();
    pollRef.current = window.setInterval(tick, 1000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [processingJobId]);

  // Map backend stage -> tiny stepper for processing
  const stageToStep = (s?: string) =>
    s === "upload_saved" ? 1 : s === "ingesting" ? 2 : s === "building_index" ? 3 : s === "done" ? 4 : 0;

  const processingSteps = (
    <Steps
      size="small"
      current={stageToStep(job?.stage)}
      items={[
        { title: "Start" },
        { title: "Saved" },
        { title: "Ingest" },
        { title: "Index" },
        { title: "Done" },
      ]}
    />
  );

  const isJobActive = Boolean(
    processingJobId && (!job?.status || (job?.status !== "done" && job?.status !== "error")),
  );

  // Defaults
  const initialSchema = useMemo(
    () => ({
      name: "documents",
      dim: FALLBACK_MODELS[0].dim,
      metric: "IP",
      index_type: "IVF_FLAT",
      nlist: 1024,
    }),
    [],
  );

  const initialSource = useMemo(
    () => ({
      source_type: "upload" as SourceType,
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
      model: FALLBACK_MODELS[0].value,
      normalize: true,
      chunk_size: 512,
      overlap: 64,
      ocr: false,
      language_detect: true,
      dedupe: true,
    }),
    [],
  );

  // Seed ALL forms once so values persist even when steps unmount
  useEffect(() => {
    schemaForm.setFieldsValue(initialSchema);
    sourceForm.setFieldsValue(initialSource);
    ingestForm.setFieldsValue(initialIngest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------
  // Helpers (robust getters)
  // ---------------------------
  const coerceNumber = (v: any, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  const getSchemaValues = () => {
    // IMPORTANT: use getFieldsValue(true) so preserved-but-unmounted fields are included
    const s = schemaForm.getFieldsValue(true) as any;
    return {
      name: s.name,
      dim: coerceNumber(s.dim, initialSchema.dim),
      metric: s.metric || initialSchema.metric,
      index_type: s.index_type || initialSchema.index_type,
      nlist: coerceNumber(
        s.index_type && String(s.index_type).startsWith("IVF") ? s.nlist : initialSchema.nlist,
        initialSchema.nlist,
      ),
    };
  };

  const getSourceValues = () => sourceForm.getFieldsValue(true) as any;
  const getIngestValues = () => {
    const i = ingestForm.getFieldsValue(true) as any;
    return {
      model: i.model || initialIngest.model,
      normalize: !!i.normalize,
      chunk_size: coerceNumber(i.chunk_size, initialIngest.chunk_size),
      overlap: coerceNumber(i.overlap, initialIngest.overlap),
      ocr: !!i.ocr,
      language_detect: !!i.language_detect,
      dedupe: !!i.dedupe,
    };
  };

  const toRawFile = (f: UploadFile): File | Blob | null => {
    const anyF: any = f;
    if (anyF?.originFileObj instanceof File || anyF?.originFileObj instanceof Blob) return anyF.originFileObj;
    if (anyF instanceof File || anyF instanceof Blob) return anyF;
    return null;
  };

  const fileDisplayName = (f: UploadFile): string =>
    (((f as any).originFileObj as any)?.webkitRelativePath) ||
    (f as any).webkitRelativePath ||
    f.name;

  // ---------------------------
  // Config preview (fix: no more empty collection/source)
  // ---------------------------
  const buildConfig = () => {
    const schema = getSchemaValues();
    const source = getSourceValues();
    const ingest = getIngestValues();

    const cfg: any = {
      collection: {
        name: schema.name,
        dim: schema.dim,
        metric: schema.metric,
        index_type: schema.index_type,
        ...(String(schema.index_type).startsWith("IVF") ? { nlist: schema.nlist } : {}),
    },
      source: { type: source.source_type },
      ingest: {
        model: ingest.model,
        normalize: ingest.normalize,
        chunk_size: ingest.chunk_size,
        overlap: ingest.overlap,
        ocr: ingest.ocr,
        language_detect: ingest.language_detect,
        dedupe: ingest.dedupe,
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
    } else if (source.source_type === "upload") {
      cfg.source.files = fileList.map(fileDisplayName);
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

  // Admin token header (optional)
  const adminToken = (typeof window !== "undefined" && localStorage.getItem("adminToken")) || undefined;
  const buildHeaders = () => (adminToken ? { "X-Admin-Token": adminToken } : undefined);

  // Upload with real progress (let browser set the boundary)
  async function uploadWithProgress(fd: FormData, onProgress: (pct: number) => void) {
    const res = await axios.post("/api/ingest/upload", fd, {
      headers: { ...(buildHeaders() || {}) },
      onUploadProgress: (evt) => {
        if (!evt.total) return;
        const pct = Math.round((evt.loaded * 100) / evt.total);
        onProgress(pct);
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      transformRequest: (d) => d,
    });
    return res.data;
  }

  // Create + ingest flow (fix: always send JSON with the actual schema values)
  const createCollection = async () => {
    const schema = getSchemaValues();
    if (!schema.name) {
      message.error("Collection name is required.");
      setCurrent(0);
      return;
    }

    // 1) Create collection (direct axios to ensure JSON body + headers)
    try {
      await axios.post(
        "/api/collections",
        {
          name: schema.name,
          dim: schema.dim,
          metric: schema.metric,
          index_type: schema.index_type,
          ...(String(schema.index_type).startsWith("IVF") ? { nlist: schema.nlist } : {}),
        },
        { headers: { "Content-Type": "application/json", ...(buildHeaders() || {}) } },
      );
      message.success("Collection created");
    } catch (err: any) {
      message.error(err?.response?.data?.detail || "Create failed");
      return;
    }

    setCreatedName(schema.name);
    onCreated?.(schema.name);

    // 2) Ingest
    const source = getSourceValues();
    const ingest = getIngestValues();

    if (source.source_type === "local") {
      try {
        await axios.post("/api/sync", undefined, { headers: { ...(buildHeaders() || {}) } });
        setSyncTriggered(true);
        setSuccess(true);
      } catch (err: any) {
        message.error(err?.response?.data?.detail || "Sync failed");
      }
      return;
    }

    if (source.source_type === "upload") {
      const fd = new FormData();
      fd.append("collection", schema.name);
      if (ingest.model) fd.append("model", ingest.model);
      fd.append("chunk_size", String(ingest.chunk_size));
      fd.append("overlap", String(ingest.overlap));
      fd.append("normalize", String(!!ingest.normalize));
      fd.append("ocr", String(!!ingest.ocr));
      fd.append("language_detect", String(!!ingest.language_detect));
      fd.append("dedupe", String(!!ingest.dedupe));

      const rawFiles = fileList
        .map((f) => ({ raw: toRawFile(f), name: fileDisplayName(f) }))
        .filter((x) => !!x.raw) as { raw: File | Blob; name: string }[];

      if (!rawFiles.length) {
        message.error("No files selected.");
        return;
      }

      rawFiles.forEach(({ raw, name }) => fd.append("files", raw, name));

      doneNotifiedRef.current = false;
      setUploading(true);
      setUploadPct(2);

      try {
        const data = await uploadWithProgress(fd, setUploadPct);
        if (data?.job?.id) {
          setProcessingJobId(data.job.id);
          message.success("Upload complete. Processing started.");
        } else {
          message.warning("Upload finished, but no job id returned.");
        }
      } catch (err: any) {
        message.error(err?.response?.data?.detail || "Upload failed");
      } finally {
        setUploading(false);
      }
      return;
    }

    // http/s3/ibm -> just show success and offer config
    setSuccess(true);
  };

  const onFinish = async () => {
    await createCollection();
  };

  // Steps
  const stepItems = [
    { title: "Schema", icon: <DatabaseOutlined /> },
    { title: "Data source", icon: <CloudUploadOutlined /> },
    { title: "Ingest options", icon: <ThunderboltOutlined /> },
    { title: "Review", icon: <CheckCircleTwoTone twoToneColor="#52c41a" /> },
  ];

  // --- Upload.Dragger props (CRITICAL): keep originFileObj via onChange + beforeUpload:false
  const uploadProps: UploadProps = {
    multiple: true,
    directory: selectFolder,
    accept: ACCEPTED_EXT,
    fileList,
    beforeUpload: () => false, // do not auto-upload
    onChange: (info) => setFileList(info.fileList),
    onRemove: (file) => {
      setFileList((prev) => prev.filter((f) => f.uid !== file.uid));
    },
    // prevent network request while still updating UI
    customRequest: ({ onSuccess }) => {
      onSuccess && onSuccess({}, new XMLHttpRequest());
    },
  };

  const content = (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card style={{ borderRadius: 12 }}>
        <Steps current={current} items={stepItems} responsive style={{ maxWidth: 920, margin: "0 auto" }} />
      </Card>

      {/* STEP 0: Schema */}
      {current === 0 && (
        <Card style={{ borderRadius: 12 }}>
          <Row gutter={[16, 16]}>
            <Col xs={24} md={12}>
              <Title level={5} style={{ marginTop: 0 }}>Collection schema</Title>
              <Form form={schemaForm} layout="vertical" preserve initialValues={initialSchema}>
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
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    <li>Match <strong>dim</strong> to your embedding model (e.g., MiniLM: 384d).</li>
                    <li><strong>IP</strong> or <strong>COSINE</strong> for sentence embeddings; <strong>L2</strong> for some image models.</li>
                    <li>IVF needs <strong>nlist</strong>; HNSW uses efConstruction/M (server picks sensible defaults).</li>
                  </ul>
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
            <Button onClick={onClose}>Cancel</Button>
            <Button type="primary" onClick={async () => { await schemaForm.validateFields(); setCurrent(1); }}>
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
              <Title level={5} style={{ marginTop: 0 }}>Choose data source</Title>
              <Form form={sourceForm} layout="vertical" preserve initialValues={initialSource} requiredMark="optional">
                <Form.Item label="Source type" name="source_type" rules={[{ required: true }]}>
                  <Select options={SOURCE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
                </Form.Item>

                {/* Upload from browser */}
                {sourceType === "upload" && (
                  <>
                    <Space direction="vertical" style={{ width: "100%" }}>
                      <Checkbox checked={selectFolder} onChange={(e) => setSelectFolder(e.target.checked)}>
                        Select folder (recursive)
                      </Checkbox>

                      <Upload.Dragger {...uploadProps}>
                        <p className="ant-upload-drag-icon">
                          <InboxOutlined />
                        </p>
                        <p className="ant-upload-text">Click or drag {selectFolder ? "folder/files" : "files"} to this area</p>
                        <p className="ant-upload-hint">
                          Supported: {ACCEPTED_EXT.replace(/\./g, "").split(",").join(", ")}. Large datasets? Prefer S3/IBM COS.
                        </p>
                      </Upload.Dragger>

                      {fileList.length > 0 && (
                        <Alert
                          type="success"
                          showIcon
                          style={{ borderRadius: 8 }}
                          message={`${fileList.length} item(s) selected`}
                          description={<span>Example path: <code>{fileDisplayName(fileList[0])}</code></span>}
                        />
                      )}
                    </Space>
                    <Divider />
                    <Alert
                      type="warning"
                      showIcon
                      message="Production tip"
                      description="For very large corpora, direct browser upload can be slow. Prefer S3/IBM COS and run server-side ingestion. This UI supports both."
                    />
                  </>
                )}

                {/* Local (server path) */}
                {sourceType === "local" && (
                  <>
                    <Form.Item label="Local path (relative to server)" name="local_path" rules={[{ required: true }]}>
                      <Input placeholder="./data" />
                    </Form.Item>
                    <Alert
                      type="success"
                      showIcon
                      message="Local ingest"
                      description={
                        <>
                          The server’s <code>/api/sync</code> ingests from <code>DATA_SOURCE_ROOT</code> in <code>.env</code>. After creation, the wizard triggers a sync automatically.
                        </>
                      }
                    />
                  </>
                )}

                {/* HTTP */}
                {sourceType === "http" && (
                  <>
                    <Form.Item label="URLs (one per line)" name="urls" rules={[{ required: true }]}>
                      <Input.TextArea rows={6} placeholder="https://example.com/docs/guide.html&#10;https://example.com/faq.html" />
                    </Form.Item>
                    <Alert type="info" showIcon message="Download via CLI" description="We’ll generate a config you can save locally and run your ingestion CLI with." />
                  </>
                )}

                {/* S3 */}
                {sourceType === "s3" && (
                  <>
                    <Form.Item label="Bucket" name={["s3", "bucket"]} rules={[{ required: true }]}><Input /></Form.Item>
                    <Form.Item label="Prefix (optional)" name={["s3", "prefix"]}><Input placeholder="docs/" /></Form.Item>
                    <Form.Item label="Region" name={["s3", "region"]} rules={[{ required: true }]}><Input /></Form.Item>
                    <Form.Item label="Endpoint (optional)" name={["s3", "endpoint"]}><Input placeholder="https://s3.amazonaws.com" /></Form.Item>
                    <Form.Item label="Access Key ID" name={["s3", "access_key_id"]} rules={[{ required: true }]}><Input.Password /></Form.Item>
                    <Form.Item label="Secret Access Key" name={["s3", "secret_access_key"]} rules={[{ required: true }]}><Input.Password /></Form.Item>
                    <Alert type="info" showIcon message="We’ll generate a config" description="Download a JSON config and run your ingestion pipeline with it." />
                  </>
                )}

                {/* IBM COS */}
                {sourceType === "ibm" && (
                  <>
                    <Form.Item label="Bucket" name={["ibm", "bucket"]} rules={[{ required: true }]}><Input /></Form.Item>
                    <Form.Item label="Prefix (optional)" name={["ibm", "prefix"]}><Input placeholder="docs/" /></Form.Item>
                    <Form.Item label="Region" name={["ibm", "region"]} rules={[{ required: true }]}><Input placeholder="eu-de" /></Form.Item>
                    <Form.Item label="Endpoint" name={["ibm", "endpoint"]} rules={[{ required: true }]}><Input placeholder="https://s3.eu-de.cloud-object-storage.appdomain.cloud" /></Form.Item>
                    <Form.Item label="Access Key ID" name={["ibm", "access_key_id"]} rules={[{ required: true }]}><Input.Password /></Form.Item>
                    <Form.Item label="Secret Access Key" name={["ibm", "secret_access_key"]} rules={[{ required: true }]}><Input.Password /></Form.Item>
                    <Alert type="info" showIcon message="We’ll generate a config" description="Download a JSON config and run your ingestion pipeline with it." />
                  </>
                )}
              </Form>
            </Col>
            <Col xs={24} md={14}>
              <Alert
                type="warning"
                showIcon
                message="Security tip"
                description={
                  sourceType === "upload"
                    ? "Files are uploaded directly to your backend via multipart/form-data. Only upload data you trust."
                    : "Credentials are only used to generate a local config for your ingestion tooling."
                }
              />
              <Divider />
              <Paragraph type="secondary">
                Supported: PDF, DOC/DOCX, PPT/PPTX, TXT/MD, HTML, CSV/JSON/JSONL, RTF, EPUB, XLS/XLSX.
                Enable OCR for scanned PDFs in the next step.
              </Paragraph>
            </Col>
          </Row>
          <Divider />
          <Space>
            <Button onClick={() => setCurrent(0)}>Back</Button>
            <Button
              type="primary"
              onClick={async () => {
                await sourceForm.validateFields();
                if (sourceType === "upload" && fileList.length === 0) {
                  message.warning("Please add at least one file (or a folder).");
                  return;
                }
                setCurrent(2);
              }}
            >
              Next
            </Button>
          </Space>
        </Card>
      )}

      {/* STEP 2: Ingest options */}
      {current === 2 && (
        <Card style={{ borderRadius: 12 }}>
          {/* SINGLE form wrapper for all ingest fields to prevent unregistration */}
          <Form form={ingestForm} layout="vertical" preserve initialValues={initialIngest}>
            <Row gutter={[16, 16]}>
              <Col xs={24} md={12}>
                <Title level={5} style={{ marginTop: 0 }}>Embeddings & chunking</Title>
                <Form.Item
                  label={
                    <Space>
                      Embedding model
                      <Tooltip title="Pick an embedding model. Its dimension must match the collection schema.">
                        <InfoCircleOutlined />
                      </Tooltip>
                    </Space>
                  }
                  name="model"
                >
                  <Select options={modelOptions} />
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
              </Col>

              <Col xs={24} md={12}>
                <Title level={5} style={{ marginTop: 0 }}>Preprocessing</Title>
                <Form.Item name="ocr" valuePropName="checked"><Checkbox>OCR scanned PDFs</Checkbox></Form.Item>
                <Form.Item name="language_detect" valuePropName="checked"><Checkbox>Language detection</Checkbox></Form.Item>
                <Form.Item name="dedupe" valuePropName="checked"><Checkbox>Deduplicate near-identical chunks</Checkbox></Form.Item>

                {/* Upload progress */}
                {sourceType === "upload" && uploading && (
                  <>
                    <Divider />
                    <Text type="secondary">Uploading…</Text>
                    <Progress percent={uploadPct} status={uploadPct < 100 ? "active" : "success"} />
                  </>
                )}

                {/* Processing animation & logs */}
                {sourceType === "upload" && processingJobId && (
                  <>
                    <Divider />
                    {processingSteps}
                    <div style={{ marginTop: 8 }} />
                    <Text type="secondary">Processing… {job?.stage ? `(${job.stage})` : ""}</Text>
                    <Progress
                      percent={typeof job?.progress === "number" ? job.progress : fakePct}
                      status={job?.status === "error" ? "exception" : "active"}
                    />
                    <pre
                      style={{
                        maxHeight: 220,
                        overflow: "auto",
                        background: "#0b1220",
                        color: "#e5e7eb",
                        padding: 12,
                        borderRadius: 8,
                      }}
                    >
                      {job?.logs_tail || ""}
                    </pre>
                  </>
                )}

                <Divider />
                <Alert
                  type="info"
                  showIcon
                  message="Heads-up"
                  description={
                    sourceType === "upload"
                      ? "Files will be uploaded and ingested into the new collection after you click Create."
                      : "These options are saved into a config for your ingestion jobs. The built-in /api/sync uses server defaults."
                  }
                />
              </Col>
            </Row>
          </Form>

          <Divider />
          <Space>
            <Button onClick={() => setCurrent(1)}>Back</Button>
            <Button type="primary" onClick={() => setCurrent(3)}>Next</Button>
          </Space>
        </Card>
      )}

      {/* STEP 3: Review */}
      {current === 3 && !success && (
        <Spin
          spinning={sourceType === "upload" && (uploading || (processingJobId && !["done", "error"].includes(job?.status)))}
          tip={job ? `Processing: ${job.stage || ""}` : "Starting…"}
        >
          <Card style={{ borderRadius: 12 }}>
            <Title level={5} style={{ marginTop: 0 }}>Review & create</Title>
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
                        description={
                          sourceType === "upload"
                            ? "We’ll create the collection and upload your files for ingestion."
                            : "We’ll create the collection now. For Local, a sync will be triggered."
                        }
                      />
                      <Divider />
                      <pre style={{ background: "#0b1220", color: "#e5e7eb", padding: 12, borderRadius: 8, overflowX: "auto" }}>
                        <code>{JSON.stringify(buildConfig(), null, 2)}</code>
                      </pre>

                      {/* Live processing view (same animation as AddDataWizard) */}
                      {sourceType === "upload" && (uploading || processingJobId) && (
                        <>
                          <Divider />
                          {processingSteps}
                          <div style={{ marginTop: 8 }} />
                          <Text type="secondary">Processing… {job?.stage ? `(${job.stage})` : ""}</Text>
                          <Progress
                            percent={
                              uploading
                                ? uploadPct
                                : typeof job?.progress === "number"
                                ? job.progress
                                : fakePct
                            }
                            status={job?.status === "error" ? "exception" : "active"}
                          />
                          <pre
                            style={{
                              maxHeight: 220,
                              overflow: "auto",
                              background: "#0b1220",
                              color: "#e5e7eb",
                              padding: 12,
                              borderRadius: 8,
                            }}
                          >
                            {job?.logs_tail || ""}
                          </pre>
                        </>
                      )}

                      {sourceType === "upload" && fileList.length > 0 && (
                        <Alert
                          type="info"
                          showIcon
                          message="Upload overview"
                          description={`${fileList.length} item(s) selected. First item: ${fileDisplayName(fileList[0])}`}
                        />
                      )}
                      {processingJobId && (
                        <Alert
                          type={job?.status === "error" ? "error" : "info"}
                          showIcon
                          message={`Job ${processingJobId}`}
                          description={`Status: ${job?.status || "starting"} • Stage: ${job?.stage || "-"}`}
                        />
                      )}
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
                      <pre style={{ background: "#0b1220", color: "#e5e7eb", padding: 12, borderRadius: 8, overflowX: "auto" }}>
{`# Save config
mui-ingest --config ./milvus-ingest.<name>.json
# Then (re)build vector DB
mui-create-vectordb`}
                      </pre>
                    </>
                  ),
                },
              ]}
            />
            <Divider />
            <Space>
              <Button onClick={() => setCurrent(2)}>Back</Button>
              {["http", "s3", "ibm"].includes(sourceType) && (
                <Button icon={<DownloadOutlined />} onClick={downloadConfig}>
                  Download config
                </Button>
              )}
              <Button
                type="primary"
                onClick={onFinish}
                loading={uploading || !!processingJobId}
                icon={<DatabaseOutlined />}
              >
                {sourceType === "upload" ? "Create & Upload" : sourceType === "local" ? "Create & Ingest" : "Create"}
              </Button>
            </Space>
          </Card>
        </Spin>
      )}

      {/* Success result */}
      {success && (
        <Result
          status="success"
          title="Collection created"
          subTitle={
            <>
              <div><strong>{createdName}</strong> was created successfully.</div>
              {sourceType === "upload" ? (
                <div>Upload & ingest job {processingJobId ? <code>{processingJobId}</code> : null} completed.</div>
              ) : syncTriggered ? (
                <div>Local ingest via <code>/api/sync</code> was triggered.</div>
              ) : (
                <div>Download the config and run your ingestion pipeline if you selected HTTP/S3/IBM.</div>
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
              {!standalone && <Button onClick={onClose}>Close</Button>}
            </Space>
          }
        />
      )}
    </Space>
  );

  if (standalone) {
    return <div style={{ maxWidth: 1000, margin: "0 auto" }}>{content}</div>;
  }

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={1000} destroyOnClose styles={{ body: { padding: 0 } }}>
      <div style={{ padding: 16 }}>{content}</div>
    </Modal>
  );
}
