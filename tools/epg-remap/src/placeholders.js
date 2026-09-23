import { eventGuideTitle, parseEventName } from './events.js';
import { formatXmltvTime } from './time.js';

const HOUR = 3_600_000;

export function isEventChannel(channel, pattern) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
  return re.test(channel.name) || re.test(channel.group ?? '') || re.test(channel.tvgName ?? '');
}

// Slots aligned to UTC multiples of slotHours, starting with the slot that contains `now`,
// until `hours` from now is covered. The current guide cell always shows the event name.
export function placeholderSlots(now, hours = 24, slotHours = 4) {
  const slot = slotHours * HOUR;
  const end = now.getTime() + hours * HOUR;
  const slots = [];
  for (let t = Math.floor(now.getTime() / slot) * slot; t < end; t += slot) {
    slots.push([new Date(t), new Date(t + slot)]);
  }
  return slots;
}

export function placeholderChannelElement(channel) {
  const children = [{ name: 'display-name', attrs: {}, children: [channel.name] }];
  if (channel.logo) children.push({ name: 'icon', attrs: { src: channel.logo }, children: [] });
  return { name: 'channel', attrs: { id: channel.id }, children };
}

// The guide cell shows the game pulled out of the channel name ("NHL: EDM vs. WPG (Sep 22
// 20:00)"), or "No event scheduled" for an idle slot; the raw channel name goes in <desc>.
export function placeholderProgrammes(channel, now, hours, slotHours, { parseEvents = true } = {}) {
  const title = parseEvents ? eventGuideTitle(parseEventName(channel.name), channel.name) : channel.name;
  return placeholderSlots(now, hours, slotHours).map(([start, stop]) => {
    const children = [{ name: 'title', attrs: { lang: 'en' }, children: [title] }];
    if (title !== channel.name) children.push({ name: 'desc', attrs: { lang: 'en' }, children: [channel.name] });
    children.push({ name: 'category', attrs: { lang: 'en' }, children: ['Sports event'] });
    return {
      name: 'programme',
      attrs: { start: formatXmltvTime(start), stop: formatXmltvTime(stop), channel: channel.id },
      children,
    };
  });
}
