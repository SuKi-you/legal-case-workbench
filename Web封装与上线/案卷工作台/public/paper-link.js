const desk = document.querySelector('.workbench');
const folio = document.querySelector('#folio');
const annotations = document.querySelector('#annotations');
const leader = document.querySelector('.annotation-leader');
const stroke = leader.querySelector('path');
const wide = matchMedia('(min-width: 881px)');
let scheduled = false;

function draw() {
  scheduled = false;
  const source = folio.querySelector('[data-annotation-anchor="source"]');
  const note = annotations.querySelector('[data-annotation-anchor="note"]');
  if (!wide.matches || !source?.getClientRects().length || !note?.getClientRects().length) {
    leader.setAttribute('hidden', '');
    return;
  }

  const area = desk.getBoundingClientRect();
  const from = source.getBoundingClientRect();
  const to = note.getBoundingClientRect();
  const x1 = Math.round(from.right - area.left + 4);
  const x2 = Math.round(to.left - area.left - 6);
  const y1 = Math.round(from.top + from.height / 2 - area.top);
  const y2 = Math.round(to.top + to.height / 2 - area.top);
  if (x2 <= x1 + 20) {
    leader.setAttribute('hidden', '');
    return;
  }
  const rightKnee = Math.round(x2 - Math.min(14, (x2 - x1) / 8));
  const leftKnee = Math.round(x1 + Math.min(34, (x2 - x1) / 5));
  stroke.setAttribute('d', `M ${x1} ${y1} H ${leftKnee} L ${rightKnee} ${y2} H ${x2}`);
  leader.removeAttribute('hidden');
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(draw);
}

const observer = new MutationObserver(schedule);
observer.observe(folio, { childList: true, subtree: true, attributes: true });
observer.observe(annotations, { childList: true, subtree: true, attributes: true });
new ResizeObserver(schedule).observe(desk);
wide.addEventListener('change', schedule);
folio.addEventListener('load', schedule, true);
document.fonts.ready.then(schedule);
schedule();
