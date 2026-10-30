// A bilateral filter: each pixel the average of those around it, weighed by
// how near they are and how alike, so noise goes and edges stay.

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

const MAX_RADIUS: i32 = 5;

fn pixel(x: i32, y: i32) -> vec4f {
    let last = vec2i(uniforms.resolution) - vec2i(1, 1);
    return textureLoad(input_texture, clamp(vec2i(x, y), vec2i(0, 0), last), 0);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let x = i32(input.position.x);
    let y = i32(input.position.y);
    // How far it looks, in pixels, and how different a colour still counts.
    let spatial = max(uniforms.scalars.x, 0.1);
    let range = max(uniforms.scalars.y, 0.001);
    let radius = min(i32(ceil(spatial * 2.0)), MAX_RADIUS);
    let center = pixel(x, y);
    var total = vec4f(0.0, 0.0, 0.0, 0.0);
    var weights = 0.0;
    for (var dy = -radius; dy <= radius; dy = dy + 1) {
        for (var dx = -radius; dx <= radius; dx = dx + 1) {
            let sample = pixel(x + dx, y + dy);
            let near = f32(dx * dx + dy * dy) / (2.0 * spatial * spatial);
            let difference = distance(sample, center);
            let alike = difference * difference / (2.0 * range * range);
            let weight = exp(-near - alike);
            total = total + sample * weight;
            weights = weights + weight;
        }
    }
    return total / weights;
}
