import { memo } from "react";
import type { Item } from "../store/item";
import ui from "../styles/ui.module.css";
import ToolCard from "./ToolCard";

/**
 * Items are grouped into turns at each user message, which is what the spacing
 * and the assistant bubble layout are keyed on.
 */
function toTurns(items: Item[]): Item[][] {
  const turns: Item[][] = [];
  for (const item of items) {
    if (turns.length === 0 || item.kind === "user") turns.push([item]);
    else turns.at(-1)?.push(item);
  }
  return turns;
}

/**
 * One line. Streaming replaces only the growing item, so memo lets every other
 * line skip re-rendering on each delta — a long transcript stays cheap.
 */
const Row = memo(function Row({ item }: { item: Item }) {
  switch (item.kind) {
    case "user":
      return (
        <div className={ui.userMsg}>
          {item.images && item.images.length > 0 ? (
            <div className={ui.bubbleImages}>
              {item.images.map((image) => (
                <img
                  key={`${image.mimeType}-${image.data.slice(0, 16)}`}
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt="附件"
                />
              ))}
            </div>
          ) : null}
          {item.text}
        </div>
      );
    case "assistant":
      return <div className={ui.assistantMsg}>{item.text}</div>;
    case "thinking":
      return <div className={ui.thinking}>{item.text}</div>;
    case "tool":
      return (
        <ToolCard
          name={item.name}
          summary={item.summary}
          text={item.text}
          isError={item.isError}
          durationMs={item.durationMs}
          running={item.running}
        />
      );
    case "notice":
      return <div className={item.error ? ui.error : ui.notice}>{item.text}</div>;
    default:
      return null;
  }
});

// `items` keeps its identity when only `busy` changes, so a turn starting or
// ending does not re-walk the transcript.
function Transcript({ items }: { items: Item[] }) {
  const turns = toTurns(items);

  return (
    <div id="turns">
      {turns.map((turn) => (
        <div className={ui.turn} key={turn[0]?.id ?? "turn"}>
          {turn.map((item) => (
            <Row item={item} key={item.id} />
          ))}
        </div>
      ))}
    </div>
  );
}

export default memo(Transcript);
