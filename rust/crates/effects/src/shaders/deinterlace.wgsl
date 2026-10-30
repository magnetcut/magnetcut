// Deinterlacing in space alone, written anew after yadif's spatial check:
// the lines of the field kept pass through, and each line of the other is
// made from the lines above and below it, averaged along whichever of three
// directions they match best, so a slanted edge stays one line.

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec2f,
    direction: vec2f,
    scalars: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

fn pixel(x: i32, y: i32) -> vec4f {
    let last = vec2i(uniforms.resolution) - vec2i(1, 1);
    return textureLoad(input_texture, clamp(vec2i(x, y), vec2i(0, 0), last), 0);
}

// How unlike the lines above and below are along a direction: three pixels'
// worth, as yadif scores it.
fn mismatch(x: i32, y: i32, slant: i32) -> f32 {
    var total = 0.0;
    for (var k = -1; k <= 1; k = k + 1) {
        total = total + distance(pixel(x + slant + k, y - 1), pixel(x - slant + k, y + 1));
    }
    return total;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let x = i32(input.position.x);
    let y = i32(input.position.y);
    // The field kept: 0 for the top one (the even lines), 1 for the bottom.
    let kept = i32(uniforms.scalars.x);
    if ((y & 1) == kept) {
        return pixel(x, y);
    }
    var slant = 0;
    var best = mismatch(x, y, 0);
    for (var candidate = -1; candidate <= 1; candidate = candidate + 2) {
        let score = mismatch(x, y, candidate);
        if (score < best) {
            best = score;
            slant = candidate;
        }
    }
    return (pixel(x + slant, y - 1) + pixel(x - slant, y + 1)) * 0.5;
}
