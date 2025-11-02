// ui/src/pages/collections/components/AddDataWizard.tsx
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
  Tooltip,
  Upload,
  Progress,
  message,
  Result,
  Tabs,
  Spin,
} from "antd";
import type { UploadFile } from "antd/es/upload/interface";
import {
  CloudUploadOutlined,
  ThunderboltOutlined,
  CheckCircleTwoTone,
  InfoCircleOutlined,
  InboxOutlined,
  DatabaseOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  CloudServerOutlined,
  DownloadOutlined,
} from "@ant-design/icons";
import { useNavigate } from "react-router-dom";

const { Title, Text, Paragraph } = Typography;

type Props = {
  open: boolean;
  collection: string;
  onClose: () => void;
  onDone?: () => void;
};

type ModelOption = { label: string; value: string; dim: number };
type SourceType = "upload" | "local" | "http" | "s3" | "ibm";

const SOURCE_OPTIONS = [
  { label: "Upload from browser", value: "upload", icon: <CloudUploadOutlined /> },
  { label: "Local folder (server)", value: "local", icon: <FolderOpenOutlined /> },
  { label: "HTTP URLs", value: "http", icon: <GlobalOutlined /> },
  { label: "Amazon S3", value: "s3", icon: <CloudUploadOutlined /> },
  { label: "IBM Cloud Object Storage", value: "ibm", icon: <CloudServerOutlined /> },
];

const ACCEPTED_EXT =
  ".pdf,.doc,.docx,.ppt,.pptx,.txt,.md,.rtf,.html,.htm,.mdx,.csv,.json,.jsonl,.epub,.xls,.xlsx";

const FALLBACK_MODELS: ModelOption[] = [
  { label: "MiniLM (384d)", value: "sentence-transformers/paraphrase-MiniLM-L6-v2", dim: 384 },
  { label: "all-MiniLM-L6-v2 (384d)", value: "sentence-transformers/all-MiniLM-L6-v2", dim: 384 },
  { label: "bge-small-en-v1.5 (384d)", value: "BAAI/bge-small-en-v1.5", dim: 384 },
  { label: "e5-small-v2 (384d)", value: "intfloat/e5-small-v2", dim: 384 },
];

export default function AddDataWizard({ open, collection, onClose, onDone }: Props) {
  const navigate = useNavigate();

  // Steps: 0 Source -> 1 Options -> 2 Review/Run
  const [current, setCurrent] = useState(0);

  // Forms
  const [sourceForm] = Form.useForm();
  const [ingestForm] = Form.useForm();

  const sourceType: SourceType = Form.useWatch("source_type", sourceForm) || "upload";

  // Models from backend (fallback on error)
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
          if (!ingestForm.getFieldValue("model")) {
            ingestForm.setFieldsValue({ model: opts[0].value });
          }
        }
      } catch {
        /* fallback to bundled list */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Upload state
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [selectFolder, setSelectFolder] = useState<boolean>(false);
  const [uploadPct, setUploadPct] = useState<number>(0);
  const [uploading, setUploading] = useState<boolean>(false);

  // Server-side processing job (for upload)
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<any>(null);
  const pollRef = useRef<number | null>(null);
  const [success, setSuccess] = useState(false);

  // NEW: ensure "Ingest completed." shows only once per job
  const doneNotifiedRef = useRef(false);
  useEffect(() => {
    // whenever a new jobId is set, allow future notification once
    doneNotifiedRef.current = false;
  }, [jobId]);

  // Defaults
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

  // Seed both forms once (ensures values persist even if step UI unmounts)
  useEffect(() => {
    sourceForm.setFieldsValue(initialSource);
    ingestForm.setFieldsValue(initialIngest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Admin token header (optional)
  const adminToken = (typeof window !== "undefined" && localStorage.getItem("adminToken")) || undefined;
  const buildHeaders = () => (adminToken ? { "X-Admin-Token": adminToken } : undefined);

  // --- Upload helper: let Axios set multipart boundary ---
  async function uploadWithProgress(fd: FormData, onProgress: (pct: number) => void) {
    const res = await axios.post("/api/ingest/upload", fd, {
      headers: { ...(buildHeaders() || {}) }, // don't set Content-Type; browser will
      onUploadProgress: (evt) => {
        if (!evt.total) return;
        const pct = Math.round((evt.loaded * 100) / evt.total);
        onProgress(pct);
      },
      // ensure axios doesn't try to serialize FormData
      transformRequest: (data) => data,
    });
    return res.data;
  }

  // --- Fake progress (last stage) until backend returns real progress ---
  const [fakePct, setFakePct] = useState(0);
  useEffect(() => {
    if (!jobId) {
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
  }, [jobId, job?.status]);

  // Poll job progress
  useEffect(() => {
    if (!jobId) return;
    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`);
        const j = await res.json();
        setJob(j.job);
        if (["done", "error"].includes(j.job?.status)) {
          if (pollRef.current) window.clearInterval(pollRef.current);
          pollRef.current = null;
          if (j.job.status === "done") {
            // show success only once per job
            if (!doneNotifiedRef.current) {
              doneNotifiedRef.current = true;
              message.success("Ingest completed.");
              setSuccess(true);
              onDone?.();
            }
          } else {
            // error can also spam; guard similarly
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
  }, [jobId, onDone]);

  const next = async () => {
    if (current === 0) {
      await sourceForm.validateFields();
      if (sourceType === "upload" && fileList.length === 0) {
        message.warning("Please add at least one file (or a folder).");
        return;
      }
    } else if (current === 1) {
      await ingestForm.validateFields();
    }
    setCurrent((c) => c + 1);
  };

  const prev = () => setCurrent((c) => Math.max(0, c - 1));

  const coerceNumber = (v: any, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > -Infinity ? n : fallback;
  };

  /**
   * Robustly append a selected file under multiple field names to satisfy
   * different backends ("files", "files[]", or "file").
   */
  const appendFileAllKeys = (fd: FormData, file: File, filename: string) => {
    fd.append("files", file, filename);
    fd.append("files[]", file, filename);
    fd.append("file", file, filename);
  };

  const doRun = async () => {
    const ingestRaw = ingestForm.getFieldsValue();
    // Ensure we always have usable numbers even if fields got unmounted
    const chunkSize = coerceNumber(ingestRaw.chunk_size, initialIngest.chunk_size);
    const overlap = coerceNumber(ingestRaw.overlap, initialIngest.overlap);
    const model = ingestRaw.model || initialIngest.model;

    if (sourceType === "upload") {
      if (!fileList.length) {
        message.error("No files selected.");
        return;
      }

      const fd = new FormData();
      // metadata fields
      fd.append("collection", collection);
      if (model) fd.append("model", String(model));
      fd.append("chunk_size", String(chunkSize));
      fd.append("overlap", String(overlap));
      fd.append("normalize", String(!!ingestRaw.normalize));
      fd.append("ocr", String(!!ingestRaw.ocr));
      fd.append("language_detect", String(!!ingestRaw.language_detect));
      fd.append("dedupe", String(!!ingestRaw.dedupe));
      fd.append("source_type", "upload");

      // files
      let appended = 0;
      fileList.forEach((f) => {
        const raw = (f as any).originFileObj as File | undefined;
        const file: File | undefined = raw ?? ((f as any) as File);
        if (file) {
          const rel = (file as any).webkitRelativePath || f.name;
          appendFileAllKeys(fd, file, rel);
          appended += 1;
        }
      });

      if (!appended) {
        message.error("No files could be read from the selection. Please re-select your files/folder.");
        return;
      }

      // new upload -> reset notification flag (redundant with jobId effect, but safe)
      doneNotifiedRef.current = false;

      setUploading(true);
      setUploadPct(2);
      try {
        const data = await uploadWithProgress(fd, setUploadPct);
        if (data?.job?.id) {
          setJobId(data.job.id);
          message.success("Upload complete. Processing started.");
        } else {
          message.warning("Upload finished, but no job id returned.");
        }
      } catch (err: any) {
        const detail = err?.response?.data?.detail;
        message.error(detail ? `Upload failed: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : "Upload failed");
      } finally {
        setUploading(false);
      }
      return;
    }

    if (sourceType === "local") {
      try {
        await axios.post("/api/sync", undefined, { headers: { ...(buildHeaders() || {}) } });
        setSuccess(true);
        message.success("Server-side sync triggered.");
        onDone?.();
      } catch (err: any) {
        message.error(err?.response?.data?.detail || "Sync failed");
      }
      return;
    }

    // HTTP/S3/IBM: produce config only
    setSuccess(true);
  };

  const buildConfig = () => {
    const src0 = sourceForm.getFieldsValue();
    const ingest0 = ingestForm.getFieldsValue();

    const srcType: SourceType = (src0.source_type as SourceType) || "upload";
    const cfg: any = {
      collection: { name: collection },
      source: { type: srcType },
      ingest: {
        model: ingest0.model || initialIngest.model,
        normalize: !!ingest0.normalize,
        chunk_size: coerceNumber(ingest0.chunk_size, initialIngest.chunk_size),
        overlap: coerceNumber(ingest0.overlap, initialIngest.overlap),
        ocr: !!ingest0.ocr,
        language_detect: !!ingest0.language_detect,
        dedupe: !!ingest0.dedupe,
      },
    };

    if (srcType === "local") {
      cfg.source.path = src0.local_path;
    } else if (srcType === "http") {
      cfg.source.urls = (src0.urls || "")
        .split("\n")
        .map((s: string) => s.trim())
        .filter(Boolean);
    } else if (srcType === "s3") {
      cfg.source = { type: "s3", ...src0.s3 };
    } else if (srcType === "ibm") {
      cfg.source = { type: "ibm", ...src0.ibm };
    } else if (srcType === "upload") {
      cfg.source.files = fileList.map((f) => {
        const file = (f as any).originFileObj as File | undefined;
        return (file as any)?.webkitRelativePath || f.name;
      });
    }
    return cfg;
  };

  const downloadConfig = () => {
    const cfg = buildConfig();
    const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `milvus-add-data.${cfg.collection?.name || "collection"}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const stepItems = [
    { title: "Source", icon: <CloudUploadOutlined /> },
    { title: "Ingest options", icon: <ThunderboltOutlined /> },
    { title: "Review", icon: <CheckCircleTwoTone twoToneColor="#52c41a" /> },
  ];

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

  const isJobActive = Boolean(jobId && (!job?.status || (job?.status !== "done" && job?.status !== "error")));

  const content = (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card style={{ borderRadius: 12 }}>
        <Steps current={current} items={stepItems} responsive style={{ maxWidth: 920, margin: "0 auto" }} />
      </Card>

      {/* STEP 0: Source */}
      {current === 0 && !success && (
        <Card style={{ borderRadius: 12 }}>
          <Row gutter={[16, 16]}>
            <Col xs={24} md={10}>
              <Title level={5} style={{ marginTop: 0 }}>
                Add data to <Text code>{collection}</Text>
              </Title>

              <Form
                form={sourceForm}
                layout="vertical"
                preserve
                initialValues={initialSource}
                requiredMark="optional"
              >
                <Form.Item label="Source type" name="source_type" rules={[{ required: true }]}>
                  <Select options={SOURCE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
                </Form.Item>

                {/* Upload */}
                {sourceType === "upload" && (
                  <>
                    <Space direction="vertical" style={{ width: "100%" }}>
                      <Checkbox checked={selectFolder} onChange={(e) => setSelectFolder(e.target.checked)}>
                        Select folder (recursive)
                      </Checkbox>
                      <Upload.Dragger
                        multiple
                        directory={selectFolder}
                        accept={ACCEPTED_EXT}
                        fileList={fileList}
                        beforeUpload={(file) => {
                          setFileList((prev) => [...prev, file]);
                          return false; // prevent auto upload
                        }}
                        onRemove={(file) => {
                          setFileList((prev) => prev.filter((f) => f.uid !== file.uid));
                        }}
                        itemRender={(originNode) => originNode}
                      >
                        <p className="ant-upload-drag-icon">
                          <InboxOutlined />
                        </p>
                        <p className="ant-upload-text">Click or drag {selectFolder ? "folder/files" : "files"} here</p>
                        <p className="ant-upload-hint">
                          Supported: {ACCEPTED_EXT.replace(/\./g, "").split(",").join(", ")}.
                        </p>
                      </Upload.Dragger>

                      {fileList.length > 0 && (
                        <Alert
                          type="success"
                          showIcon
                          style={{ borderRadius: 8 }}
                          message={`${fileList.length} item(s) selected`}
                          description={
                            <span>
                              Example path:{" "}
                              <code>
                                {(((fileList[0] as any).originFileObj as any)?.webkitRelativePath) || fileList[0].name}
                              </code>
                            </span>
                          }
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
                          The server’s <code>/api/sync</code> ingests from <code>DATA_SOURCE_ROOT</code> in <code>.env</code>. After you click <strong>Run</strong>, the wizard triggers a sync.
                        </>
                      }
                    />
                  </>
                )}

                {/* HTTP */}
                {sourceType === "http" && (
                  <>
                    <Form.Item label="URLs (one per line)" name="urls" rules={[{ required: true }]}>
                      <Input.TextArea
                        rows={6}
                        placeholder="https://example.com/docs/guide.html&#10;https://example.com/faq.html"
                      />
                    </Form.Item>
                    <Alert
                      type="info"
                      showIcon
                      message="We’ll generate a config"
                      description="Download a JSON config and run your ingestion CLI with it."
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
                type="info"
                showIcon
                message="About adding data"
                description={
                  sourceType === "upload"
                    ? "Files are uploaded directly to your backend via multipart/form-data. Only upload data you trust."
                    : sourceType === "local"
                    ? "The server will run its configured ingestion from DATA_SOURCE_ROOT. It may update multiple collections depending on your pipeline."
                    : "Credentials/URLs are only used to generate a local config for your ingestion tooling."
                }
              />
              <Divider />
              <Paragraph type="secondary">
                Supported: PDF, DOC/DOCX, PPT/PPTX, TXT/MD, HTML, CSV/JSON/JSONL, RTF, EPUB, XLS/XLSX. Enable OCR for
                scanned PDFs in the next step.
              </Paragraph>
            </Col>
          </Row>

          <Divider />
          <Space>
            <Button onClick={onClose}>Cancel</Button>
            <Button type="primary" onClick={next} disabled={sourceType === "upload" && fileList.length === 0}>
              Next
            </Button>
          </Space>
        </Card>
      )}

      {/* STEP 1: Ingest options */}
      {current === 1 && !success && (
        <Card style={{ borderRadius: 12 }}>
          {/* SINGLE form wrapper for all ingest fields to prevent unregistration */}
          <Form form={ingestForm} layout="vertical" preserve initialValues={initialIngest}>
            <Row gutter={[16, 16]}>
              <Col xs={24} md={12}>
                <Title level={5} style={{ marginTop: 0 }}>
                  Embeddings & chunking
                </Title>

                <Form.Item
                  label={
                    <Space>
                      Embedding model
                      <Tooltip title="Pick an embedding model. It should match the collection's embedding dimension.">
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
                <Title level={5} style={{ marginTop: 0 }}>
                  Preprocessing
                </Title>

                <Form.Item name="ocr" valuePropName="checked">
                  <Checkbox>OCR scanned PDFs</Checkbox>
                </Form.Item>
                <Form.Item name="language_detect" valuePropName="checked">
                  <Checkbox>Language detection</Checkbox>
                </Form.Item>
                <Form.Item name="dedupe" valuePropName="checked">
                  <Checkbox>Deduplicate near-identical chunks</Checkbox>
                </Form.Item>
              </Col>
            </Row>
          </Form>

          {/* Upload progress */}
          {sourceType === "upload" && uploading && (
            <>
              <Divider />
              <Text type="secondary">Uploading…</Text>
              <Progress percent={uploadPct} status={uploadPct < 100 ? "active" : "success"} />
            </>
          )}

          {/* Processing animation & logs (also shown on Step 2) */}
          {sourceType === "upload" && jobId && (
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
                ? "Files will be uploaded and ingested into the selected collection after you click Run."
                : sourceType === "local"
                ? "We will trigger /api/sync on the server. Progress for that job is not tracked here."
                : "We will generate a JSON config for your ingestion CLI."
            }
          />

          <Divider />
          <Space>
            <Button onClick={prev}>Back</Button>
            <Button type="primary" icon={<CloudUploadOutlined />} onClick={() => setCurrent(2)}>
              Next
            </Button>
          </Space>
        </Card>
      )}

      {/* STEP 2: Review & Run */}
      {current === 2 && !success && (
        <Spin spinning={sourceType === "upload" && isJobActive} tip={job ? `Processing: ${job.stage || ""}` : "Starting…"}>
          <Card style={{ borderRadius: 12 }}>
            <Title level={5} style={{ marginTop: 0 }}>
              Review & run for <Text code>{collection}</Text>
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
                        message={
                          sourceType === "upload"
                            ? "Ready to upload"
                            : sourceType === "local"
                            ? "Ready to trigger server sync"
                            : "Ready to generate config"
                        }
                        description={
                          sourceType === "upload"
                            ? "We’ll upload your files and start ingestion. Progress and logs will appear here."
                            : sourceType === "local"
                            ? "We’ll call /api/sync on the server to ingest from DATA_SOURCE_ROOT."
                            : "Download the config JSON and run your ingestion CLI with it."
                        }
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

                      {/* Live processing view right on the Review tab */}
                      {sourceType === "upload" && (uploading || jobId) && (
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
                            status={job?.status === "error" ? "exception" : uploading ? "active" : "active"}
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
                      >{`# Save config
mui-ingest --config ./milvus-add-data.${collection}.json
# Then (re)build vector DB
mui-create-vectordb`}</pre>
                    </>
                  ),
                },
              ]}
            />

            <Divider />
            <Space>
              <Button onClick={prev}>Back</Button>
              {["http", "s3", "ibm"].includes(sourceType) && (
                <Button icon={<DownloadOutlined />} onClick={downloadConfig}>
                  Download config
                </Button>
              )}
              <Button
                type="primary"
                onClick={doRun}
                loading={sourceType === "upload" && (uploading || !!jobId)}
                icon={<DatabaseOutlined />}
              >
                {sourceType === "upload" ? "Upload & Ingest" : sourceType === "local" ? "Run" : "Finish"}
              </Button>
            </Space>
          </Card>
        </Spin>
      )}

      {/* Success result */}
      {success && (
        <Result
          status="success"
          title={sourceType === "upload" ? "Data added" : sourceType === "local" ? "Sync triggered" : "Config ready"}
          subTitle={
            <>
              {sourceType === "upload" && (
                <>
                  <div>
                    New data was added to <strong>{collection}</strong>.
                  </div>
                  <div>You can now query it in the RAG view.</div>
                </>
              )}
              {sourceType === "local" && (
                <>
                  <div>
                    Server-side ingest via <code>/api/sync</code> was triggered.
                  </div>
                  <div>Check server logs for progress.</div>
                </>
              )}
              {["http", "s3", "ibm"].includes(sourceType) && <> <div>Download the config and run your ingestion pipeline.</div> </>}
            </>
          }
          extra={
            <Space>
              {["http", "s3", "ibm"].includes(sourceType) && (
                <Button icon={<DownloadOutlined />} onClick={downloadConfig}>
                  Download config
                </Button>
              )}
              <Button type="primary" onClick={() => navigate("/rag", { state: { collection } })}>
                Open in RAG
              </Button>
              <Button onClick={() => navigate("/collections")}>Back to Collections</Button>
              <Button onClick={onClose}>Close</Button>
            </Space>
          }
        />
      )}
    </Space>
  );

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={1000}
      destroyOnClose
      styles={{ body: { padding: 0 } }}
      title={
        <Space>
          <CloudUploadOutlined />
          <span>Add data to collection</span>
          <Text code>{collection}</Text>
        </Space>
      }
    >
      <div style={{ padding: 16 }}>{content}</div>
    </Modal>
  );
}
