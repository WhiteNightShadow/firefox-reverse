import React, { useState } from "react";
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
  const [fetchedModels, setFetchedModels] = useState([]);
  const [fetchMsg, setFetchMsg] = useState("");
  const [manual, setManual] = useState(false); // 自定义：手动输入模型名（端点 /v1/models 没列出的，如 claude-*）
  const [saved, setSaved] = useState(false);

  const isCustom = provider === "custom";

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
    setFetchMsg("获取中…");
    try {
      const list = await fetchModels(customUrl, apiKey);
      setFetchedModels(list);
      setManual(false);
      if (customProtocol === "anthropic") {
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
  const showFetchBtn = isCustom; // 两种协议都可尝试从端点拉取模型
  const modelOptions = isCustom ? customModels : current.models;

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
              {showFetchBtn && (
                <button type="button" className="settings-pane__btn-ghost" onClick={doFetchModels} title="从 Base URL 的 /v1/models 拉取">
                  获取模型列表
                </button>
              )}
            </div>
            {fetchMsg && <span className="settings-pane__hint">{fetchMsg}</span>}
            {customProtocol === "anthropic" && (
              <span className="settings-pane__hint">Anthropic 端点已内置 Claude 模型可直接选；其它版本选「手动输入」。</span>
            )}
          </>
        ) : modelOptions.length > 0 ? (
          <select
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              setSaved(false);
            }}
          >
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={model}
            placeholder="模型名"
            onChange={(e) => {
              setModel(e.target.value);
              setSaved(false);
            }}
          />
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
        Key 明文存于浏览器 prefs，仅本机。自定义端点：OpenAI 兼容填 /v1 根地址即可，Anthropic 兼容会走 /v1/messages。
      </p>
    </div>
  );
}
