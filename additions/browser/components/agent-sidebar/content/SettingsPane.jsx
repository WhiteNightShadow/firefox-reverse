import React, { useState, useRef } from "react";
// providers 由宿主注入（index.jsx 运行时用 ChromeUtils 加载 providers.sys.mjs 后传入），
// 使本组件零静态依赖 .sys.mjs，便于 esbuild 打包成干净 bundle。

/**
 * 设置面板：选 provider、填 API Key/Token、选/填模型，保存到注入的 ConfigStore。
 * 「自定义」provider 额外支持：协议(OpenAI/Anthropic) + Base URL + 从端点拉取模型列表。
 *
 * @param {object} props
 * @param {object} props.store               ConfigStore 实例（宿主注入）
 * @param {Array}  props.providers           provider 元数据列表
 * @param {(baseUrl:string,token:string)=>Promise<string[]>} [props.fetchModels]
 * @param {() => void} [props.onClose]
 */
export default function SettingsPane({ store, providers, fetchModels, onClose }) {
  const [provider, setProvider] = useState(store.getActiveProvider());
  const current = providers.find((p) => p.id === provider) || providers[0];
  const [apiKey, setApiKey] = useState(store.getApiKey(provider));
  const [model, setModel] = useState(store.getModel(provider) || current.defaultModel);
  const [confirmTools, setConfirmTools] = useState(store.getConfirmTools ? store.getConfirmTools() : false);
  const [customUrl, setCustomUrl] = useState(store.getCustomBaseUrl ? store.getCustomBaseUrl() : "");
  const [customProtocol, setCustomProtocol] = useState(store.getCustomProtocol ? store.getCustomProtocol() : "openai");
  const [customReasoningEffort, setCustomReasoningEffort] = useState(
    store.getCustomReasoningEffort ? store.getCustomReasoningEffort() : "auto"
  );
  const [fetchedModels, setFetchedModels] = useState([]);
  const [fetchMsg, setFetchMsg] = useState("");
  const [manual, setManual] = useState(false); // 自定义：手动输入模型名（端点 /v1/models 没列出的，如 claude-*）
  const [saved, setSaved] = useState(false);

  const isCustom = provider === "custom";
  // 在途拉取守卫：拉取期间切 provider / 重复点按钮时，过期响应直接丢弃（否则旧 provider 的
  // 模型列表会塞进新 provider 的下拉，保存后聊天必错模型名）
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const fetchSeqRef = useRef(0);

  function onProviderChange(id) {
    setProvider(id);
    setApiKey(store.getApiKey(id));
    const p = providers.find((x) => x.id === id);
    setModel(store.getModel(id) || p?.defaultModel || "");
    setFetchedModels([]);
    setFetchMsg("");
    setManual(false);
    setSaved(false);
  }

  function save() {
    store.setActiveProvider(provider);
    store.setApiKey(provider, apiKey);
    store.setModel(provider, model);
    if (isCustom) {
      store.setCustomBaseUrl && store.setCustomBaseUrl(customUrl);
      store.setCustomProtocol && store.setCustomProtocol(customProtocol);
      store.setCustomReasoningEffort && store.setCustomReasoningEffort(customReasoningEffort);
    }
    if (store.setConfirmTools) {
      store.setConfirmTools(confirmTools);
    }
    setSaved(true);
  }

  async function doFetchModels() {
    if (!fetchModels) {
      return;
    }
    const seq = ++fetchSeqRef.current;
    const forProvider = provider;
    const stale = () => seq !== fetchSeqRef.current || providerRef.current !== forProvider;
    setFetchMsg("获取中…");
    try {
      // 自定义用用户填的 Base URL；内置 provider 用其官方 baseUrl（模型列表动态拉取，内置列表仅兜底）
      const list = await fetchModels(isCustom ? customUrl : current.baseUrl, apiKey);
      if (stale()) {
        return;
      }
      setFetchedModels(list);
      setManual(false);
      if (isCustom && customProtocol === "anthropic") {
        const cl = list.filter((x) => /claude/i.test(x));
        setFetchMsg(
          cl.length
            ? `动态获取到 ${cl.length} 个 Claude 模型`
            : `该端点 /v1/models 未列出 Claude（仅返回 ${list.length} 个其它模型），已用内置 Claude 列表；其它版本可「手动输入」`
        );
      } else {
        setFetchMsg(`获取到 ${list.length} 个模型`);
        if (!model && list.length) {
          setModel(list[0]);
        }
      }
    } catch (e) {
      if (stale()) {
        return;
      }
      setFetchMsg("失败：" + ((e && e.message) || e));
    }
    setSaved(false);
  }

  // 自定义端点模型来源：
  // - OpenAI 协议：用「获取模型列表」拉取结果。
  // - Anthropic 协议：若端点 /v1/models 真列出了 Claude 模型 → 用拉取到的(动态)；否则回退内置 Claude 列表。
  const fetchedClaude = fetchedModels.filter((x) => /claude/i.test(x));
  const customModels =
    customProtocol === "anthropic"
      ? fetchedClaude.length
        ? fetchedClaude
        : current.anthropicModels || []
      : fetchedModels;
  // 内置 provider：拉取成功用动态列表，否则回退内置硬编码列表
  const modelOptions = isCustom ? customModels : fetchedModels.length ? fetchedModels : current.models;

  return (
    <div className="settings-pane">
      <header className="settings-pane__bar">
        <span>设置</span>
        {onClose && (
          <button type="button" onClick={onClose} title="关闭">
            ×
          </button>
        )}
      </header>

      <label className="settings-pane__field">
        模型提供方
        <select value={provider} onChange={(e) => onProviderChange(e.target.value)}>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      {isCustom && (
        <>
          <label className="settings-pane__field">
            协议
            <select
              value={customProtocol}
              onChange={(e) => {
                setCustomProtocol(e.target.value);
                setManual(false);
                setFetchMsg("");
                setSaved(false);
              }}
            >
              <option value="openai">OpenAI 兼容（/v1/chat/completions）</option>
              <option value="anthropic">Anthropic 兼容（/v1/messages）</option>
            </select>
          </label>
          <label className="settings-pane__field">
            Base URL
            <input
              type="text"
              value={customUrl}
              placeholder="http://host:port  或  https://api.example.com"
              onChange={(e) => {
                setCustomUrl(e.target.value);
                setSaved(false);
              }}
            />
          </label>
        </>
      )}

      <label className="settings-pane__field">
        {isCustom ? "API Key / Token" : "API Key"}
        <input
          type="password"
          value={apiKey}
          placeholder="sk-..."
          onChange={(e) => {
            setApiKey(e.target.value);
            setSaved(false);
          }}
        />
      </label>

      {isCustom && customProtocol === "openai" && (
        <label className="settings-pane__field">
          思考等级
          <select
            value={customReasoningEffort}
            onChange={(e) => {
              setCustomReasoningEffort(e.target.value);
              setSaved(false);
            }}
          >
            <option value="auto">自动（使用模型或网关默认值）</option>
            <option value="none">关闭（none）</option>
            <option value="minimal">极低（minimal）</option>
            <option value="low">低（low）</option>
            <option value="medium">中（medium）</option>
            <option value="high">高（high）</option>
            <option value="xhigh">极高（xhigh）</option>
            <option value="max">最大（max）</option>
          </select>
          <span className="settings-pane__hint">
            仅对支持 reasoning_effort 的模型生效；不同模型支持的等级可能不同，接口报参数错误时请改回“自动”。
          </span>
        </label>
      )}

      {isCustom && customProtocol === "anthropic" && (
        <span className="settings-pane__hint">
          Anthropic 的扩展思考使用不同配置结构，本版本由模型或网关默认控制。
        </span>
      )}

      <label className="settings-pane__field">
        模型
        {isCustom ? (
          <>
            <div className="settings-pane__modelrow">
              {customModels.length > 0 && !manual ? (
                <select
                  className="settings-pane__grow"
                  value={model}
                  onChange={(e) => {
                    if (e.target.value === "__manual__") {
                      setManual(true);
                      setModel("");
                    } else {
                      setModel(e.target.value);
                    }
                    setSaved(false);
                  }}
                >
                  {model && !customModels.includes(model) && (
                    <option value={model}>{model}（当前）</option>
                  )}
                  {customModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  <option value="__manual__">✏️ 手动输入其它模型…</option>
                </select>
              ) : (
                <input
                  className="settings-pane__grow"
                  type="text"
                  value={model}
                  placeholder={customProtocol === "anthropic" ? "如 claude-opus-4-7" : "点「获取模型列表」选择，或手填"}
                  onChange={(e) => {
                    setModel(e.target.value);
                    setSaved(false);
                  }}
                />
              )}
              <button
                type="button"
                className="settings-pane__btn-ghost"
                onClick={doFetchModels}
                title="从 Base URL 拉取模型列表（自动探测 /models 与 /v1/models）"
              >
                获取模型列表
              </button>
            </div>
            {fetchMsg && (
              <span className="settings-pane__hint" style={{ whiteSpace: "pre-wrap" }}>
                {fetchMsg}
              </span>
            )}
            {customProtocol === "anthropic" && (
              <span className="settings-pane__hint">Anthropic 端点已内置 Claude 模型可直接选；其它版本选「手动输入」。</span>
            )}
          </>
        ) : (
          <>
            <div className="settings-pane__modelrow">
              {modelOptions.length > 0 ? (
                <select
                  className="settings-pane__grow"
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value);
                    setSaved(false);
                  }}
                >
                  {model && !modelOptions.includes(model) && (
                    <option value={model}>{model}（当前）</option>
                  )}
                  {modelOptions.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="settings-pane__grow"
                  type="text"
                  value={model}
                  placeholder="模型名"
                  onChange={(e) => {
                    setModel(e.target.value);
                    setSaved(false);
                  }}
                />
              )}
              <button
                type="button"
                className="settings-pane__btn-ghost"
                onClick={doFetchModels}
                title="从该提供方端点动态拉取模型列表（内置列表仅作兜底）"
              >
                获取模型列表
              </button>
            </div>
            {fetchMsg && (
              <span className="settings-pane__hint" style={{ whiteSpace: "pre-wrap" }}>
                {fetchMsg}
              </span>
            )}
          </>
        )}
      </label>

      <label className="settings-pane__field" style={{ flexDirection: "row", alignItems: "center", gap: "8px" }}>
        <input
          type="checkbox"
          checked={confirmTools}
          onChange={(e) => {
            setConfirmTools(e.target.checked);
            setSaved(false);
          }}
        />
        改动型工具（执行JS/导航/网络/存JS/jsvmp）执行前需确认
      </label>

      <div className="settings-pane__actions">
        <button type="button" onClick={save}>
          保存
        </button>
        {saved && <span className="settings-pane__saved">已保存 ✓</span>}
      </div>

      <p className="settings-pane__note">
        Key 明文存于浏览器 prefs，仅本机。自定义端点：Base URL 填 API 服务根地址（如
        https://api.example.com 或 https://dashscope.aliyuncs.com/compatible-mode/v1，
        不是文档/控制台页面）；已带 /v1 等版本段时不会重复叠加。
      </p>
    </div>
  );
}
