/*!
Minimal in-program FHE computation-graph builder.

Mirrors `encrypt_dsl::graph::GraphBuilder`'s wire format (see
`encrypt_types::graph` for the spec) without pulling in the proc-macro
toolchain. Only the operations Veil uses are exposed here.

The serialised graph is the payload of the Encrypt program's
`execute_graph` instruction:

```text
ix_data = [4u8 (disc)] | u16 LE graph_len | graph_bytes | u8 num_inputs
graph_bytes = [Header 8B] [Nodes N×9B] [Constants section]
```

# Node kinds (`encrypt_types::graph::GraphNodeKind`)
| Kind | Name           |
|------|----------------|
| 0    | Input          |
| 2    | Constant       |
| 3    | Op             |
| 4    | Output         |

# Op codes (`encrypt_types::types::FheOperation`)
- 0  Add
- 3  Subtract
- 9  AddScalar
- 11 SubtractScalar
- 44 IsGreaterOrEqual
- 50 IsGreaterOrEqualScalar

# FHE type IDs (`encrypt_types::types::FheType`)
- 0  EBool
- 4  EUint64
*/

extern crate alloc;
use alloc::vec::Vec;

const KIND_INPUT: u8 = 0;
const KIND_CONSTANT: u8 = 2;
const KIND_OP: u8 = 3;
const KIND_OUTPUT: u8 = 4;

const FHE_BOOL: u8 = 0;
const FHE_U64: u8 = 4;

const OP_ADD: u8 = 0;
const OP_SUB: u8 = 3;
const OP_MUL_SCALAR: u8 = 10;
const OP_GE_SCALAR: u8 = 50;

/// Discriminator for the Encrypt program's `execute_graph` instruction.
pub const IX_EXECUTE_GRAPH: u8 = 4;

struct GraphBuilder {
    nodes: Vec<[u8; 9]>,
    constants: Vec<u8>,
    num_inputs: u8,
    num_constants: u8,
    num_ops: u8,
    num_outputs: u8,
}

impl GraphBuilder {
    fn new() -> Self {
        Self {
            nodes: Vec::new(),
            constants: Vec::new(),
            num_inputs: 0,
            num_constants: 0,
            num_ops: 0,
            num_outputs: 0,
        }
    }

    fn push(&mut self, kind: u8, op_type: u8, fhe_type: u8, a: u16, b: u16, c: u16) -> u16 {
        let idx = self.nodes.len() as u16;
        let mut buf = [0u8; 9];
        buf[0] = kind;
        buf[1] = op_type;
        buf[2] = fhe_type;
        buf[3..5].copy_from_slice(&a.to_le_bytes());
        buf[5..7].copy_from_slice(&b.to_le_bytes());
        buf[7..9].copy_from_slice(&c.to_le_bytes());
        self.nodes.push(buf);
        idx
    }

    fn add_input(&mut self, fhe_type: u8) -> u16 {
        self.num_inputs += 1;
        self.push(KIND_INPUT, 0, fhe_type, 0xFFFF, 0xFFFF, 0xFFFF)
    }

    fn add_constant_u64(&mut self, value: u64) -> u16 {
        let offset = self.constants.len() as u16;
        self.constants.extend_from_slice(&value.to_le_bytes());
        self.num_constants += 1;
        self.push(KIND_CONSTANT, 0, FHE_U64, offset, 0xFFFF, 0xFFFF)
    }

    fn add_op(&mut self, op: u8, fhe_type: u8, a: u16, b: u16) -> u16 {
        self.num_ops += 1;
        self.push(KIND_OP, op, fhe_type, a, b, 0xFFFF)
    }

    fn add_output(&mut self, fhe_type: u8, source: u16) -> u16 {
        self.num_outputs += 1;
        self.push(KIND_OUTPUT, 0, fhe_type, source, 0xFFFF, 0xFFFF)
    }

    fn serialize(self) -> Vec<u8> {
        let total = 8 + self.nodes.len() * 9 + self.constants.len();
        let mut buf = Vec::with_capacity(total);
        let constants_len = self.constants.len() as u16;
        buf.push(1); // version
        buf.push(self.num_inputs);
        buf.push(0); // num_plaintext_inputs
        buf.push(self.num_constants);
        buf.push(self.num_ops);
        buf.push(self.num_outputs);
        buf.extend_from_slice(&constants_len.to_le_bytes());
        for n in &self.nodes {
            buf.extend_from_slice(n);
        }
        buf.extend_from_slice(&self.constants);
        buf
    }
}

/// Wrap a serialized graph in the `execute_graph` instruction-data envelope.
fn ix_data(graph: &[u8], num_inputs: u8) -> Vec<u8> {
    let mut data = Vec::with_capacity(1 + 2 + graph.len() + 1);
    data.push(IX_EXECUTE_GRAPH);
    data.extend_from_slice(&(graph.len() as u16).to_le_bytes());
    data.extend_from_slice(graph);
    data.push(num_inputs);
    data
}

/// `out = a + b` over EUint64.
///
/// Encrypted inputs: `a`, `b`. Output: `out` (= a + b).
pub fn add_u64() -> Vec<u8> {
    let mut g = GraphBuilder::new();
    let a = g.add_input(FHE_U64);
    let b = g.add_input(FHE_U64);
    let s = g.add_op(OP_ADD, FHE_U64, a, b);
    g.add_output(FHE_U64, s);
    ix_data(&g.serialize(), 2)
}

/// `out = a - b` over EUint64. Saturates at 0 inside the FHE evaluator.
pub fn sub_u64() -> Vec<u8> {
    let mut g = GraphBuilder::new();
    let a = g.add_input(FHE_U64);
    let b = g.add_input(FHE_U64);
    let s = g.add_op(OP_SUB, FHE_U64, a, b);
    g.add_output(FHE_U64, s);
    ix_data(&g.serialize(), 2)
}

/// `out = (deposit * 8000) >= (debt * 10000)` returning an EBool.
///
/// Encrypted inputs: `deposit`, `debt`. Output: `out`.
/// `is_healthy` graph from `fhe::graphs::is_healthy_plaintext`.
pub fn is_healthy() -> Vec<u8> {
    let mut g = GraphBuilder::new();
    let deposit = g.add_input(FHE_U64);
    let debt = g.add_input(FHE_U64);
    let liq_bps = g.add_constant_u64(super::LIQ_THRESHOLD_BPS);
    let denom = g.add_constant_u64(super::BPS_DENOM);
    let lhs = g.add_op(OP_MUL_SCALAR, FHE_U64, deposit, liq_bps);
    let rhs = g.add_op(OP_MUL_SCALAR, FHE_U64, debt, denom);
    let cmp = g.add_op(OP_GE_SCALAR, FHE_U64, lhs, rhs);
    g.add_output(FHE_BOOL, cmp);
    ix_data(&g.serialize(), 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check_header(bytes: &[u8], inputs: u8, constants: u8, ops: u8, outputs: u8) {
        // ix_data: [4u8] [u16 len] [graph...] [num_inputs]
        assert_eq!(bytes[0], IX_EXECUTE_GRAPH);
        let len = u16::from_le_bytes([bytes[1], bytes[2]]) as usize;
        let graph = &bytes[3..3 + len];
        assert_eq!(graph[0], 1); // version
        assert_eq!(graph[1], inputs);
        assert_eq!(graph[2], 0); // plaintext inputs
        assert_eq!(graph[3], constants);
        assert_eq!(graph[4], ops);
        assert_eq!(graph[5], outputs);
        assert_eq!(bytes[3 + len], inputs);
    }

    #[test]
    fn add_u64_graph_shape() {
        check_header(&add_u64(), 2, 0, 1, 1);
    }

    #[test]
    fn sub_u64_graph_shape() {
        check_header(&sub_u64(), 2, 0, 1, 1);
    }

    #[test]
    fn is_healthy_graph_shape() {
        // 2 inputs, 2 constants (bps + denom), 3 ops, 1 output
        check_header(&is_healthy(), 2, 2, 3, 1);
    }
}
