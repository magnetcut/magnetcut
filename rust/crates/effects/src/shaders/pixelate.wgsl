// The picture in blocks of `size` pixels, each the colour at its middle: what
// was there can't be made out again (a face, a plate: docs/HIDE.md).

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

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let size = max(uniforms.scalars.x, 1.0);
    let block = floor(input.position.xy / size);
    let middle = min((block + 0.5) * size, uniforms.resolution - vec2f(1.0));
    return textureLoad(input_texture, vec2i(middle), 0);
}
