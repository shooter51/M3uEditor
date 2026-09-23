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

export function placeholderProgrammes(channel, now, hours, slotHours) {
  return placeholderSlots(now, hours, slotHours).map(([start, stop]) => ({
    name: 'programme',
    attrs: { start: formatXmltvTime(start), stop: formatXmltvTime(stop), channel: channel.id },
    children: [{ name: 'title', attrs: { lang: 'en' }, children: [channel.name] }],
  }));
}
