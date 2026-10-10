import Foundation

/// Anki template rendering. Port of packages/core/src/anki/render.ts.
public enum CardRender {
    public struct Context {
        public var fields: [String: String]
        public var tags: [String]
        public var deck: String
        public var notetype: String
        public var cardName: String
        public var clozeOrd: Int?
    }

    indirect enum Node {
        case text(String)
        case variable(String)
        case section(name: String, inverted: Bool, children: [Node])
    }

    static func parse(_ tpl: String) -> [Node] {
        // Each stack frame: (section name, inverted, children)
        var stack: [(name: String, inverted: Bool, children: [Node])] = [("", false, [])]
        let ns = tpl as NSString
        let re = try! NSRegularExpression(pattern: "\\{\\{([\\s\\S]*?)\\}\\}")
        var last = 0
        for m in re.matches(in: tpl, range: NSRange(location: 0, length: ns.length)) {
            if m.range.location > last { stack[stack.count - 1].children.append(.text(ns.substring(with: NSRange(location: last, length: m.range.location - last)))) }
            last = m.range.location + m.range.length
            let tag = ns.substring(with: m.range(at: 1)).trimmingCharacters(in: .whitespacesAndNewlines)
            if tag.hasPrefix("#") || tag.hasPrefix("^") {
                stack.append((String(tag.dropFirst()).trimmingCharacters(in: .whitespaces), tag.hasPrefix("^"), []))
            } else if tag.hasPrefix("/") {
                let name = String(tag.dropFirst()).trimmingCharacters(in: .whitespaces)
                if let idx = stack.lastIndex(where: { $0.name == name }), idx > 0 {
                    while stack.count > idx {
                        let frame = stack.removeLast()
                        stack[stack.count - 1].children.append(.section(name: frame.name, inverted: frame.inverted, children: frame.children))
                    }
                } else {
                    stack[stack.count - 1].children.append(.text(ns.substring(with: m.range)))
                }
            } else if tag.hasPrefix("!") {
                continue
            } else {
                stack[stack.count - 1].children.append(.variable(tag))
            }
        }
        if last < ns.length { stack[stack.count - 1].children.append(.text(ns.substring(from: last))) }
        while stack.count > 1 {
            let frame = stack.removeLast()
            stack[stack.count - 1].children.append(.section(name: frame.name, inverted: frame.inverted, children: frame.children))
        }
        return stack[0].children
    }

    public static func stripHTML(_ html: String) -> String {
        var s = html.replacingOccurrences(of: "<br\\s*/?>", with: " ", options: [.regularExpression, .caseInsensitive])
        s = s.replacingOccurrences(of: "<[^>]*>", with: "", options: .regularExpression)
        for (a, b) in [("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'")] { s = s.replacingOccurrences(of: a, with: b) }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func nonEmpty(_ html: String?) -> Bool {
        guard let h = html else { return false }
        return !stripHTML(h).replacingOccurrences(of: "\\s+", with: "", options: .regularExpression).isEmpty
    }

    static let clozeRe = try! NSRegularExpression(pattern: "\\{\\{c(\\d+)::([\\s\\S]*?)(?:::([\\s\\S]*?))?\\}\\}")

    public static func renderCloze(_ text: String, ord: Int, side: Character) -> String {
        let ns = text as NSString
        var out = ""
        var last = 0
        for m in clozeRe.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            let n = Int(ns.substring(with: m.range(at: 1))) ?? 0
            let body = ns.substring(with: m.range(at: 2))
            let hint = m.range(at: 3).location != NSNotFound ? ns.substring(with: m.range(at: 3)) : ""
            if n != ord { out += body }
            else if side == "q" { out += "<span class=\"cloze\">[\(hint.isEmpty ? "..." : hint)]</span>" }
            else { out += "<span class=\"cloze\">\(body)</span>" }
            last = m.range.location + m.range.length
        }
        out += ns.substring(from: last)
        return out
    }

    static func furigana(_ s: String, mode: String) -> String {
        let re = try! NSRegularExpression(pattern: " ?([^ >\\[\\]]+?)\\[(.+?)\\]")
        let ns = s as NSString
        var out = ""
        var last = 0
        for m in re.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            let base = ns.substring(with: m.range(at: 1)), reading = ns.substring(with: m.range(at: 2))
            out += mode == "kana" ? reading : mode == "kanji" ? base : "<ruby><rb>\(base)</rb><rt>\(reading)</rt></ruby>"
            last = m.range.location + m.range.length
        }
        return out + ns.substring(from: last)
    }

    static func apply(_ tag: String, _ ctx: Context, side: Character, front: String) -> String {
        var parts = tag.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        let name = parts.removeLast().trimmingCharacters(in: .whitespaces)
        var value: String
        switch name {
        case "FrontSide": value = front
        case "Tags": value = ctx.tags.joined(separator: " ")
        case "Deck": value = ctx.deck
        case "Subdeck": value = ctx.deck.components(separatedBy: "::").last ?? ctx.deck
        case "Card": value = ctx.cardName
        case "Type": value = ctx.notetype
        default: value = ctx.fields[name] ?? ""
        }
        for f in parts.reversed().map({ $0.trimmingCharacters(in: .whitespaces).lowercased() }) {
            switch f {
            case "cloze": if let o = ctx.clozeOrd { value = renderCloze(value, ord: o, side: side) }
            case "text": value = stripHTML(value)
            case "type": value = ""
            case "hint": value = nonEmpty(value) ? "<details class=\"hint\"><summary>Hint</summary>\(value)</details>" : ""
            case "furigana", "kana", "kanji": value = furigana(value, mode: f)
            default: break
            }
        }
        return value
    }

    static func render(_ nodes: [Node], _ ctx: Context, side: Character, front: String) -> String {
        var out = ""
        for n in nodes {
            switch n {
            case let .text(t): out += t
            case let .variable(v): out += apply(v, ctx, side: side, front: front)
            case let .section(name, inverted, children):
                let present: Bool
                if name.hasPrefix("c"), let k = Int(name.dropFirst()), let ord = ctx.clozeOrd { present = k == ord }
                else if name == "Tags" { present = !ctx.tags.isEmpty }
                else { present = nonEmpty(ctx.fields[name]) }
                if present != inverted { out += render(children, ctx, side: side, front: front) }
            }
        }
        return out
    }

    static func soundTags(_ html: String) -> String {
        html.replacingOccurrences(of: "\\[sound:([^\\]]+)\\]", with: "<audio controls preload=\"none\" src=\"$1\"></audio>", options: .regularExpression)
    }

    public static func renderCard(qfmt: String, afmt: String, _ ctx: Context) -> (front: String, back: String) {
        let front = soundTags(render(parse(qfmt), ctx, side: "q", front: ""))
        let back = soundTags(render(parse(afmt), ctx, side: "a", front: front))
        return (front, back)
    }

    public static func isEmptyRender(_ html: String) -> Bool {
        html.range(of: "<img|<audio|<video", options: [.regularExpression, .caseInsensitive]) == nil && !nonEmpty(html)
    }
}
