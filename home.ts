// Home screen — greeting, profile chip, and the profile sheet. All local:
// nothing on this page touches the network.
import { myName, setName, myAvatar, setAvatar, bestRun, AVATARS } from "./shared/profile";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Morning";
  if (h < 18) return "Afternoon";
  return "Evening";
}

function render(): void {
  const name = myName();
  const chip = $("chip");
  chip.classList.toggle("unset", !name);
  $("chipAv").textContent = myAvatar();
  $("chipName").textContent = name || "Set name";

  $("greetH").textContent = name ? `${greeting()}, ${name}.` : "Ready to play?";
  const best = bestRun("sentence");
  $("greetP").innerHTML = best
    ? `Best Phrase run · <b>${best.toLocaleString()} pts</b>`
    : "Beam a phrase in light. Claim your name. Climb the board.";
}

// ---- profile sheet ----
let pickedAvatar = myAvatar();

const grid = $("avgrid");
for (const a of AVATARS) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = a;
  b.onclick = () => {
    pickedAvatar = a;
    grid.querySelectorAll("button").forEach((x) => x.classList.toggle("sel", x === b));
  };
  if (a === pickedAvatar) b.classList.add("sel");
  grid.appendChild(b);
}

function openSheet(): void {
  $<HTMLInputElement>("pname").value = myName();
  document.body.classList.add("sheet-open");
}
function closeSheet(): void {
  document.body.classList.remove("sheet-open");
}

$("chip").onclick = openSheet;
$("scrim").onclick = closeSheet;
$<HTMLButtonElement>("psave").onclick = () => {
  const n = $<HTMLInputElement>("pname").value.trim();
  if (n) setName(n);
  setAvatar(pickedAvatar);
  closeSheet();
  render();
};
$<HTMLInputElement>("pname").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $<HTMLButtonElement>("psave").click();
});

render();
