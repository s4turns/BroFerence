"""Tests for the pure helpers in irc_bridge.

These three functions turn unvalidated, free-form user input (room names,
usernames, chat text) into protocol-legal IRC strings, so they are where a bad
input actually breaks something on the wire. Everything else in the module is
socket I/O and is covered by the manual end-to-end checks instead.

Run:  python -m pytest server/tests -q
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from irc_bridge import (  # noqa: E402
    CHANNEL_MAXLEN,
    NICK_MAXLEN,
    channel_for_room,
    nick_for_username,
    nick_from_prefix,
    parse_line,
    split_message,
)


# ── channel_for_room ──────────────────────────────────────────────────────────

def test_channel_basic():
    assert channel_for_room('blcknd', prefix='bro-') == '#bro-blcknd'


def test_channel_lowercases():
    assert channel_for_room('BlckND', prefix='bro-') == '#bro-blcknd'


@pytest.mark.parametrize('room, expected', [
    ('my room', '#bro-my-room'),          # space
    ('a,b', '#bro-a-b'),                  # comma would start a second channel
    ('a:b', '#bro-a-b'),                  # colon starts the trailing param
    ('a\x07b', '#bro-a-b'),               # BEL
    ('a\r\nJOIN #evil', '#bro-a-join-evil'),  # CRLF injection
])
def test_channel_strips_illegal_characters(room, expected):
    assert channel_for_room(room, prefix='bro-') == expected


def test_channel_collapses_and_trims_separators():
    assert channel_for_room('  --my   room--  ', prefix='bro-') == '#bro-my-room'


def test_channel_falls_back_when_nothing_survives():
    # Entirely emoji: sanitising leaves nothing, so a hash stands in.
    channel = channel_for_room('🎉🎉', prefix='bro-')
    assert channel.startswith('#bro-')
    assert len(channel) > len('#bro-')


def test_channel_fallback_is_stable_and_distinct():
    assert channel_for_room('🎉', prefix='bro-') == channel_for_room('🎉', prefix='bro-')
    assert channel_for_room('🎉', prefix='bro-') != channel_for_room('🚀', prefix='bro-')


def test_channel_respects_max_length():
    channel = channel_for_room('x' * 200, prefix='bro-')
    assert len(channel) <= CHANNEL_MAXLEN


def test_channel_empty_room_name():
    assert channel_for_room('', prefix='bro-').startswith('#bro-')


# ── nick_for_username ─────────────────────────────────────────────────────────

def test_nick_basic():
    assert nick_for_username('interdome') == 'interdome'


def test_nick_keeps_rfc_special_characters():
    assert nick_for_username('a[b]c`d') == 'a[b]c`d'


def test_nick_strips_illegal_characters():
    assert nick_for_username('bad nick!@#') == 'badnick'


def test_nick_may_not_start_with_digit_or_hyphen():
    assert nick_for_username('123abc') == 'abc'
    assert nick_for_username('-abc') == 'abc'


def test_nick_falls_back_when_nothing_survives():
    nick = nick_for_username('🎉')
    assert nick.startswith('user')
    assert not nick[0].isdigit()


def test_nick_respects_max_length():
    assert len(nick_for_username('n' * 100)) <= NICK_MAXLEN


def test_nick_empty_username():
    assert nick_for_username('') .startswith('user')


# ── split_message ─────────────────────────────────────────────────────────────

def test_split_short_message_untouched():
    assert split_message('hello') == ['hello']


def test_split_newlines_become_separate_messages():
    # Flattening these would let a user forge extra lines in the channel.
    assert split_message('one\ntwo\r\nthree') == ['one', 'two', 'three']


def test_split_drops_empty_lines():
    assert split_message('a\n\n\nb') == ['a', 'b']


def test_split_long_line_is_chunked():
    chunks = split_message('x' * 1000, limit=100)
    assert len(chunks) == 10
    assert all(len(c.encode('utf-8')) <= 100 for c in chunks)
    assert ''.join(chunks) == 'x' * 1000


def test_split_never_cuts_a_multibyte_character():
    # 'é' is 2 bytes; a naive byte slice at an odd limit would split one.
    text = 'é' * 100
    chunks = split_message(text, limit=15)
    assert ''.join(chunks) == text
    for chunk in chunks:
        assert len(chunk.encode('utf-8')) <= 15
        chunk.encode('utf-8').decode('utf-8')  # would raise if truncated


def test_split_handles_emoji():
    text = '🎉' * 50  # 4 bytes each
    chunks = split_message(text, limit=10)
    assert ''.join(chunks) == text
    assert all(len(c.encode('utf-8')) <= 10 for c in chunks)


def test_split_empty_input():
    assert split_message('') == []
    assert split_message(None) == []


# ── parse_line / nick_from_prefix ─────────────────────────────────────────────

def test_parse_privmsg():
    prefix, command, params = parse_line(':nick!user@host PRIVMSG #chan :hello world')
    assert prefix == 'nick!user@host'
    assert command == 'PRIVMSG'
    assert params == ['#chan', 'hello world']


def test_parse_preserves_colons_in_trailing():
    _, _, params = parse_line(':n!u@h PRIVMSG #c :see http://x/y :z')
    assert params[-1] == 'see http://x/y :z'


def test_parse_ping_without_prefix():
    prefix, command, params = parse_line('PING :cookie123')
    assert prefix is None
    assert command == 'PING'
    assert params == ['cookie123']


def test_parse_numeric():
    _, command, params = parse_line(':server 433 * newnick :Nickname is already in use')
    assert command == '433'
    assert params[-1] == 'Nickname is already in use'


def test_nick_from_prefix():
    assert nick_from_prefix('nick!user@host') == 'nick'
    assert nick_from_prefix('server.name') == 'server.name'
    assert nick_from_prefix(None) == ''
