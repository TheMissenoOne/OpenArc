Gold context (from the instructions and stub only):
- Type: `type FamilyTree = Record<string, string[]>`: each key is a parent's name, its value lists that parent's children. A child can have one or two parents. Names are unique.
- Degree of separation = the shortest number of connections from personA to personB.
- One connection: parent <-> child (either direction), and also sibling <-> sibling (children who share a parent): "Isla and Tariq are siblings and have a separation of 1"; "a separation of 2 from you to your father's brother".
- Instruction example: Tariq -> Helena -> Isla -> Uma is 3; Uma and Isla is 1; Isla and Kevin are not connected.
- If the two people are not connected, return the value that represents "no known relationship" (the instructions do not state it).
- Useful built-ins: Map<string, Set<string>>, Object.entries(tree): [string, string[]][]; a queue (array with push/shift) for breadth-first search.
