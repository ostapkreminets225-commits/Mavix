import { useMemo, useState } from "react";
import { ShieldCheck, ListChecks, MessageCircleQuestion } from "lucide-react";
import { answerRequest, setChatMode, type PermissionRequest } from "../../chat";
import { Markdown, toolLabel } from "./ToolView";
import { LocalImage, findImages, withoutImages, type ImageRef } from "./LocalImage";
import { relativePath } from "../../util";

type Input = Record<string, any>;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function preview(request: PermissionRequest, cwd: string): string {
  const input = request.input as Input;
  if (str(input.command)) return str(input.command);
  if (str(input.file_path)) {
    const path = cwd ? relativePath(cwd, str(input.file_path)) : str(input.file_path);
    if (str(input.new_string)) return `${path}\n\n- ${str(input.old_string).split("\n").join("\n- ")}\n+ ${str(input.new_string).split("\n").join("\n+ ")}`;
    if (str(input.content)) return `${path}\n\n${str(input.content)}`;
    return path;
  }
  if (str(input.url)) return str(input.url);
  if (str(input.query)) return str(input.query);
  return Object.keys(input).length ? JSON.stringify(input, null, 2) : "";
}

function alwaysLabel(suggestions: Input[]): string | null {
  if (suggestions.length === 0) return null;
  const first = suggestions[0];
  if (first.type === "setMode" && first.mode === "acceptEdits") return "Так, і приймати правки далі";
  if (first.type === "addRules" && Array.isArray(first.rules) && first.rules[0]) {
    const rule = first.rules[0];
    return rule.ruleContent ? `Так, і не питати для «${String(rule.ruleContent).slice(0, 40)}»` : `Так, і не питати для ${toolLabel(String(rule.toolName ?? ""))}`;
  }
  if (first.type === "addDirectories") return "Так, і дозволити цю папку";
  return "Так, завжди";
}

function PermissionCard({ chatKey, request, cwd }: { chatKey: string; request: PermissionRequest; cwd: string }) {
  const [reason, setReason] = useState("");
  const always = alwaysLabel(request.suggestions as Input[]);
  const body = preview(request, cwd);
  return (
    <div className="req">
      <div className="req-title">
        <ShieldCheck size={15} strokeWidth={1.8} />
        <span>
          Дозволити <b>{toolLabel(request.toolName)}</b>?
        </span>
        {request.description && <span className="req-desc">{request.description}</span>}
      </div>
      {body && <pre className="req-input">{body.length > 4000 ? `${body.slice(0, 4000)}\n…` : body}</pre>}
      <div className="req-actions">
        <button className="btn primary small" autoFocus onClick={() => answerRequest(chatKey, request.requestId, "allow")}>
          Так
        </button>
        {always && (
          <button className="btn small" onClick={() => answerRequest(chatKey, request.requestId, "always")}>
            {always}
          </button>
        )}
        <input
          className="req-reason"
          value={reason}
          placeholder="Ні — що зробити інакше?"
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") answerRequest(chatKey, request.requestId, "deny", { message: reason });
          }}
        />
        <button className="btn small danger" onClick={() => answerRequest(chatKey, request.requestId, "deny", { message: reason })}>
          Ні
        </button>
      </div>
    </div>
  );
}

type OptionView = { label: string; description: string; preview: string; images: ImageRef[] };

function optionView(option: Input): OptionView {
  const preview = str(option.preview);
  const description = str(option.description);
  return {
    label: str(option.label),
    description: withoutImages(description),
    preview: withoutImages(preview),
    images: [...findImages(preview), ...findImages(description)],
  };
}

function QuestionBlock({
  question,
  picked,
  other,
  onToggle,
  onOther,
}: {
  question: Input;
  picked: string[];
  other: string;
  onToggle: (label: string) => void;
  onOther: (value: string) => void;
}) {
  const options = (Array.isArray(question.options) ? question.options : []).map(optionView);
  const own = findImages(str(question.question));
  const gallery = options.some((o) => o.images.length > 0);
  const multi = question.multiSelect === true;
  return (
    <div className="req-question">
      {str(question.header) && <span className="req-q-header">{str(question.header)}</span>}
      <div className="req-q-text">{withoutImages(str(question.question))}</div>
      {own.length > 0 && (
        <div className="req-q-shots">
          {own.map((image) => (
            <LocalImage key={image.path} image={image} className="req-shot" />
          ))}
        </div>
      )}
      <div className={`req-options${gallery ? " gallery" : ""}`}>
        {options.map((option, index) => {
          const on = picked.includes(option.label);
          return (
            <div
              key={option.label || index}
              role="button"
              tabIndex={0}
              className={`req-option${on ? " on" : ""}`}
              onClick={() => onToggle(option.label)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onToggle(option.label);
                }
              }}
            >
              {option.images.length > 0 && (
                <div className="req-option-shots">
                  {option.images.map((image) => (
                    <LocalImage key={image.path} image={image} className="req-shot" />
                  ))}
                </div>
              )}
              <div className="req-option-line">
                <span className={`req-radio${multi ? " square" : ""}${on ? " on" : ""}`} />
                <div className="req-option-text">
                  <b>{option.label}</b>
                  {option.description && <span>{option.description}</span>}
                </div>
              </div>
              {option.preview && <pre className="req-option-preview">{option.preview}</pre>}
            </div>
          );
        })}
      </div>
      <div className={`req-other${other.trim() ? " on" : ""}`}>
        <span className={`req-radio${multi ? " square" : ""}${other.trim() ? " on" : ""}`} />
        <input className="req-reason" placeholder="Інша відповідь…" value={other} onChange={(e) => onOther(e.target.value)} />
      </div>
    </div>
  );
}

function hasMedia(questions: Input[]): boolean {
  return questions.some(
    (q) => findImages(str(q.question)).length > 0 || (Array.isArray(q.options) ? q.options : []).some((o: Input) => optionView(o).images.length > 0),
  );
}

function QuestionCard({ chatKey, request }: { chatKey: string; request: PermissionRequest }) {
  const questions: Input[] = Array.isArray((request.input as Input).questions) ? (request.input as Input).questions : [];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const media = useMemo(() => hasMedia(questions), [questions]);
  const toggle = (question: Input, label: string) => {
    const key = str(question.question);
    setPicked((current) => {
      const list = current[key] ?? [];
      if (question.multiSelect) return { ...current, [key]: list.includes(label) ? list.filter((l) => l !== label) : [...list, label] };
      return { ...current, [key]: [label] };
    });
    if (!question.multiSelect) setOther((current) => ({ ...current, [key]: "" }));
  };
  const typeOther = (question: Input, value: string) => {
    const key = str(question.question);
    setOther((current) => ({ ...current, [key]: value }));
    if (!question.multiSelect && value.trim()) setPicked((current) => ({ ...current, [key]: [] }));
  };
  const ready = questions.every((q) => (picked[str(q.question)]?.length ?? 0) > 0 || (other[str(q.question)] ?? "").trim());
  const submit = () => {
    const answers: Record<string, string> = {};
    for (const q of questions) {
      const key = str(q.question);
      const typed = (other[key] ?? "").trim();
      const chosen = picked[key] ?? [];
      answers[key] = q.multiSelect ? [...chosen, ...(typed ? [typed] : [])].join(", ") : typed || chosen.join(", ");
    }
    answerRequest(chatKey, request.requestId, "allow", { input: { ...request.input, answers } });
  };
  return (
    <div className={`req req-ask${media ? " has-media" : ""}`}>
      <div className="req-title">
        <MessageCircleQuestion size={15} strokeWidth={1.8} />
        <span>Claude питає</span>
        {media && <span className="req-desc">натисни на скріншот, щоб вибрати · ⤢ — на весь екран</span>}
      </div>
      {questions.map((q, index) => (
        <QuestionBlock
          key={index}
          question={q}
          picked={picked[str(q.question)] ?? []}
          other={other[str(q.question)] ?? ""}
          onToggle={(label) => toggle(q, label)}
          onOther={(value) => typeOther(q, value)}
        />
      ))}
      <div className="req-actions">
        <button className="btn primary small" disabled={!ready} onClick={submit}>
          Відповісти
        </button>
        <button className="btn small" onClick={() => answerRequest(chatKey, request.requestId, "deny", { message: "The user skipped these questions." })}>
          Пропустити
        </button>
      </div>
    </div>
  );
}

function PlanCard({ chatKey, request }: { chatKey: string; request: PermissionRequest }) {
  const [feedback, setFeedback] = useState("");
  const plan = str((request.input as Input).plan);
  const approve = async (mode: "acceptEdits" | "default") => {
    await answerRequest(chatKey, request.requestId, "allow");
    await setChatMode(chatKey, mode);
  };
  return (
    <div className="req">
      <div className="req-title">
        <ListChecks size={15} strokeWidth={1.8} />
        <span>Claude підготував план. Виконувати?</span>
      </div>
      {plan && (
        <div className="req-plan">
          <Markdown source={plan} />
        </div>
      )}
      <div className="req-actions">
        <button className="btn primary small" onClick={() => approve("acceptEdits")}>
          Так, і приймати правки
        </button>
        <button className="btn small" onClick={() => approve("default")}>
          Так, питати дозвіл
        </button>
        <input
          className="req-reason"
          value={feedback}
          placeholder="Ні — що змінити в плані?"
          onChange={(e) => setFeedback(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") answerRequest(chatKey, request.requestId, "deny", { message: feedback || "The user wants to keep planning." });
          }}
        />
        <button className="btn small danger" onClick={() => answerRequest(chatKey, request.requestId, "deny", { message: feedback || "The user wants to keep planning." })}>
          Ні
        </button>
      </div>
    </div>
  );
}

export function RequestCard({ chatKey, request, cwd }: { chatKey: string; request: PermissionRequest; cwd: string }) {
  if (request.toolName === "AskUserQuestion") return <QuestionCard chatKey={chatKey} request={request} />;
  if (request.toolName === "ExitPlanMode") return <PlanCard chatKey={chatKey} request={request} />;
  return <PermissionCard chatKey={chatKey} request={request} cwd={cwd} />;
}
