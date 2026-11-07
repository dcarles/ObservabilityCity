// The dashboard's own small legend: only what the table needs. (The town has a bigger one with tabs: src/legend.ts.)

export interface DashLegendLine {
  id: string
  /** The coloured dot, or null for a line that is about something else. */
  level: 'ok' | 'warn' | 'bad' | 'none' | null
  title: string
  text: string
}

export const DASH_LEGEND: readonly DashLegendLine[] = [
  { id: 'ok', level: 'ok', title: 'Green', text: 'Healthy. Errors are 0 and latency is under the service level (SLA)' },
  { id: 'warn', level: 'warn', title: 'Amber', text: 'A warning, for example latency from 90% of the SLA' },
  { id: 'bad', level: 'bad', title: 'Red', text: 'Errors above 0, latency over the SLA, or the service is down' },
  { id: 'none', level: 'none', title: 'Grey', text: 'No fresh data. Never read as healthy' },
  { id: 'dlq', level: null, title: 'DLQ', text: 'Dead letters waiting next to a service name. Queues themselves stay in the details' },
  { id: 'load', level: null, title: 'Load', text: 'CPU and memory bars for each region. A database shows its busiest tenant (%RU)' },
  { id: 'buttons', level: null, title: 'Connections, Details', text: 'Who calls this service and whom it calls, and the full detail panel' },
  { id: 'feed', level: null, title: 'Whole page grey', text: 'The live feed went quiet for 45 seconds, so the numbers are old' },
]

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function dashLegendHtml(lines: readonly DashLegendLine[] = DASH_LEGEND): string {
  return `<div class="dl-head"><b>What the colours mean</b></div>${lines.map((l) => `
    <div class="dl-row" data-id="${l.id}"><span class="dl-mark">${l.level ? `<span class="dot ${l.level}"></span>` : '<span class="dl-bar"></span>'}</span><div><b>${esc(l.title)}</b><span>${esc(l.text)}</span></div></div>`).join('')}`
}
