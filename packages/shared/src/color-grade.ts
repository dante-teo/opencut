export interface ColorGrade {
  exposure: number;
  temperature: number;
  tint: number;
  contrast: number;
  saturation: number;
  curve: { input: number; output: number }[];
}

export const defaultColorGrade: ColorGrade = {
  exposure: 0,
  temperature: 0,
  tint: 0,
  contrast: 1,
  saturation: 1,
  curve: [],
};

export function gradePixels(pixels: Uint8ClampedArray, grade: ColorGrade) {
  const curve = [
    { input: 0, output: 0 },
    ...grade.curve,
    { input: 1, output: 1 },
  ];
  const lut = new Uint8ClampedArray(1024);
  let stop = 1;
  for (let i = 0; i < lut.length; i++) {
    const value = i / (lut.length - 1);
    while (value > curve[stop]!.input) stop++;
    const before = curve[stop - 1]!;
    const after = curve[stop]!;
    const t = (value - before.input) / (after.input - before.input);
    lut[i] = (before.output + (after.output - before.output) * t) * 255;
  }
  const red = 2 ** (grade.exposure + grade.temperature * 0.5);
  const green = 2 ** (grade.exposure - grade.tint * 0.5);
  const blue = 2 ** (grade.exposure - grade.temperature * 0.5);
  const adjust = (value: number, luma: number) => {
    const saturated = luma + (value - luma) * grade.saturation;
    const contrasted = (saturated - 0.5) * grade.contrast + 0.5;
    return lut[
      Math.round(Math.max(0, Math.min(1, contrasted)) * (lut.length - 1))
    ]!;
  };
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue;
    const r = (pixels[i]! * red) / 255;
    const g = (pixels[i + 1]! * green) / 255;
    const b = (pixels[i + 2]! * blue) / 255;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    pixels[i] = adjust(r, luma);
    pixels[i + 1] = adjust(g, luma);
    pixels[i + 2] = adjust(b, luma);
  }
}
