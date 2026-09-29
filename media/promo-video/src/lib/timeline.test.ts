import {cue, cueLocal, sceneStart, seriesLocal, themeAt, wordsLocal, coloredCuesStrict} from './timeline';
describe('timeline', () => {
  it('pins the two clicks', () => {
    expect(cue('S07.click').frame).toBe(1920);
    expect(cue('S17.click').frame).toBe(4860);
    expect(cueLocal('S07', 'S07.click')).toBe(180);
  });
  it('expands series', () => expect(seriesLocal('S01', 'S01.pulse')).toEqual([60, 75, 90, 105]));
  it('knows themes', () => { expect(themeAt(0)).toBe('dark'); expect(themeAt(500)).toBe('light'); });
  it('has local words for spoken scenes', () => {
    expect(sceneStart('S02')).toBe(180);
    expect(wordsLocal('S02')[0].screen).toBe('Une');
    expect(wordsLocal('S01')).toEqual([]);
  });
  it('never lists a series head as a coloured event', () => {
    expect(coloredCuesStrict().some((c) => c.id === 'S01.pulse')).toBe(false);
    expect(coloredCuesStrict().some((c) => c.id === 'S01.pulse.1')).toBe(true);
  });
});
