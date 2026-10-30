// Unsharp masking: each pixel pushed away from the blur of those around it.

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

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let x = i32(input.position.x);
    let y = i32(input.position.y);
    let amount = uniforms.scalars.x;
    let center = pixel(x, y);
    // A 3x3 binomial blur.
    let sides = pixel(x - 1, y) + pixel(x + 1, y) + pixel(x, y - 1) + pixel(x, y + 1);
    let corners = pixel(x - 1, y - 1) + pixel(x + 1, y - 1) + pixel(x - 1, y + 1)
        + pixel(x + 1, y + 1);
    let blur = (center * 4.0 + sides * 2.0 + corners) / 16.0;
    let sharpened = center.rgb + (center.rgb - blur.rgb) * amount;
    // The compositor's colours are straight, not premultiplied.
    return vec4f(clamp(sharpened, vec3f(0.0), vec3f(1.0)), center.a);
}
